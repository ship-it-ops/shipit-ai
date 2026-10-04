// ModelClient over the AI SDK's Vertex provider. One family per entry point:
// the package root for Gemini, /anthropic for Claude, /maas for open models.
// Authentication is Application Default Credentials (Workload Identity on GKE,
// `gcloud auth application-default login` locally); there is no API key.
import {
  APICallError,
  generateText,
  isStepCount,
  jsonSchema,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from 'ai';
import { createVertex } from '@ai-sdk/google-vertex';
import { createVertexAnthropic } from '@ai-sdk/google-vertex/anthropic';
import { createVertexMaas } from '@ai-sdk/google-vertex/maas';
import type { StoredMessage } from '@shipit-ai/agents';
import type { AiModelConfig } from '@shipit-ai/shared';
import {
  ModelCallError,
  type ModelClient,
  type ModelFinish,
  type ModelStepRequest,
  type ModelStepResult,
} from './model-client.js';

// The SDK's provider-neutral reasoning levels. An agent's `effort` maps onto
// one of these; anything else is ignored rather than failing the run.
const REASONING_LEVELS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']);
type ReasoningLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

// Wording Vertex uses when a prompt does not fit: Gemini ("input token count
// … exceeds the maximum") and Claude ("prompt is too long").
const CONTEXT_EXCEEDED =
  /token count .* exceeds|prompt is too long|context length|too many tokens/i;

const FINISH: Record<string, ModelFinish> = {
  stop: 'stop',
  'tool-calls': 'tool_calls',
  length: 'length',
  'content-filter': 'refusal',
  error: 'error',
  other: 'error',
};

export interface VertexModelClientOptions {
  project?: string;
  location?: string;
  /** Test seam: builds the SDK model for a catalog entry. */
  resolveModel?: (model: AiModelConfig) => LanguageModel;
}

export class VertexModelClient implements ModelClient {
  private readonly resolveModel: (model: AiModelConfig) => LanguageModel;

  constructor(opts: VertexModelClientOptions) {
    this.resolveModel = opts.resolveModel ?? vertexResolver(opts.project ?? '', opts.location);
  }

  async step(request: ModelStepRequest): Promise<ModelStepResult> {
    if (request.signal.aborted) throw new ModelCallError('ABORTED', 'The run was cancelled.');
    const tools: ToolSet = Object.fromEntries(
      request.tools.map((t) => [
        t.name,
        tool({ description: t.description, inputSchema: jsonSchema(t.inputSchema as never) }),
      ]),
    );
    const reasoning =
      request.effort && REASONING_LEVELS.has(request.effort)
        ? (request.effort as ReasoningLevel)
        : undefined;
    try {
      const result = await generateText({
        model: this.resolveModel(request.model),
        instructions: request.instructions,
        messages: request.messages as unknown as ModelMessage[],
        tools,
        // One model call per step: the run loop decides and runs the tools.
        stopWhen: isStepCount(1),
        abortSignal: request.signal,
        // Three attempts in all for a retryable failure (429, 5xx).
        maxRetries: 2,
        ...(reasoning ? { reasoning } : {}),
      });
      return {
        // Only the model's own message. For a call to an undeclared tool (or
        // with input the SDK rejects) the SDK appends a tool message with its
        // own error result; the gateway must decide and record every call, so
        // that message is dropped and the call is passed on like any other.
        messages: result.responseMessages.filter(
          (m) => m.role === 'assistant',
        ) as unknown as StoredMessage[],
        toolCalls: result.toolCalls.map((c) => ({
          callId: c.toolCallId,
          name: c.toolName,
          input: c.input,
        })),
        text: result.text,
        finish: FINISH[result.finishReason] ?? 'error',
        usage: {
          input: result.usage.inputTokens ?? 0,
          output: result.usage.outputTokens ?? 0,
          ...(result.usage.outputTokenDetails?.reasoningTokens
            ? { reasoning: result.usage.outputTokenDetails.reasoningTokens }
            : {}),
          ...(result.usage.inputTokenDetails?.cacheReadTokens
            ? { cacheRead: result.usage.inputTokenDetails.cacheReadTokens }
            : {}),
        },
      };
    } catch (err) {
      throw toModelCallError(err, request.signal);
    }
  }
}

function toModelCallError(err: unknown, signal: AbortSignal): ModelCallError {
  if (signal.aborted) return new ModelCallError('ABORTED', 'The run was cancelled.');
  // The SDK wraps a retried failure in a RetryError whose lastError is the API error.
  const inner = (err as { lastError?: unknown }).lastError ?? err;
  const message = inner instanceof Error ? inner.message : String(inner);
  if (APICallError.isInstance(inner) && CONTEXT_EXCEEDED.test(message)) {
    return new ModelCallError('CONTEXT_EXCEEDED', message);
  }
  return new ModelCallError('MODEL_ERROR', message);
}

function vertexResolver(
  project: string,
  location = 'global',
): (model: AiModelConfig) => LanguageModel {
  // Providers are created once, on first use of a family.
  let gemini: ReturnType<typeof createVertex> | undefined;
  let anthropic: ReturnType<typeof createVertexAnthropic> | undefined;
  let maas: ReturnType<typeof createVertexMaas> | undefined;
  return (model) => {
    switch (model.family) {
      case 'anthropic':
        anthropic ??= createVertexAnthropic({ project, location });
        return anthropic(model.modelId);
      case 'maas':
        maas ??= createVertexMaas({ project, location });
        return maas(model.modelId);
      default:
        gemini ??= createVertex({ project, location });
        return gemini(model.modelId);
    }
  };
}
