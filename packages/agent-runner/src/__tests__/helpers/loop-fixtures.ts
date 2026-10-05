// Fixtures for the run-loop suites: a scripted model, fake tools, and an agent
// definition with the grants the suites need.
import type { AgentDefinition, StoredMessage, ToolEffect } from '@shipit-ai/agents';
import type { AiModelConfig } from '@shipit-ai/shared';
import type {
  ModelClient,
  ModelStepRequest,
  ModelStepResult,
  ModelToolCall,
} from '../../model/model-client.js';
import type { RunnerTool } from '../../tools/runner-tool.js';

export const MODEL: AiModelConfig = {
  key: 'gemini',
  label: 'Gemini',
  family: 'gemini',
  modelId: 'gemini-3.8-flash',
  contextWindow: 1_048_576,
  tools: true,
};

export const definition = (extra: Partial<AgentDefinition> = {}): AgentDefinition => ({
  instructions: 'Answer ownership questions using the tools.',
  model: 'gemini',
  limits: { maxSteps: 10, maxTokens: 100_000, timeoutSeconds: 300, dailyTokens: 1_000_000 },
  grants: {
    services: {
      graph: { read: 'allow', write: 'off', delete: 'off' },
      gh: { read: 'allow', write: 'allow', delete: 'off' },
    },
    tools: {},
  },
  output: { schema: null },
  ...extra,
});

type Step = (request: ModelStepRequest) => ModelStepResult | Promise<ModelStepResult>;

/** A model that plays back scripted steps and records every request. */
export class ScriptedModel implements ModelClient {
  readonly requests: ModelStepRequest[] = [];
  constructor(private readonly script: Step[]) {}

  async step(request: ModelStepRequest): Promise<ModelStepResult> {
    // Copy: the loop reuses arrays between steps.
    this.requests.push({ ...request, messages: [...request.messages] });
    const next = this.script.shift();
    if (!next) throw new Error('ScriptedModel: no step left');
    return next(request);
  }
}

export const answer =
  (text: string, usage = { input: 100, output: 10 }): Step =>
  () => ({
    messages: [{ role: 'assistant', content: [{ type: 'text', text }] }],
    toolCalls: [],
    text,
    finish: 'stop',
    usage,
  });

/** An assistant message asking for tools, with a Gemini-style signature on each call. */
export const toolCallMessage = (calls: ModelToolCall[]): StoredMessage => ({
  role: 'assistant',
  content: calls.map((c) => ({
    type: 'tool-call',
    toolCallId: c.callId,
    toolName: c.name,
    input: c.input,
    providerOptions: { google: { thoughtSignature: `sig-${c.callId}` } },
  })),
});

export const callTools =
  (calls: ModelToolCall[], usage = { input: 100, output: 10 }): Step =>
  () => ({
    messages: [toolCallMessage(calls)],
    toolCalls: calls,
    text: '',
    finish: 'tool_calls',
    usage,
  });

export interface FakeTool extends RunnerTool {
  calls: Array<Record<string, unknown>>;
  /** [start, end] timestamps per execution, to check overlap. */
  spans: Array<[number, number]>;
}

/** A tool taking `{ q: string }` that answers `{ answer: q }` after `delayMs`. */
export function fakeTool(
  id: string,
  effect: ToolEffect,
  opts: { delayMs?: number; result?: (input: Record<string, unknown>) => unknown } = {},
): FakeTool {
  const tool: FakeTool = {
    calls: [],
    spans: [],
    descriptor: {
      id,
      service: id.split('.')[0]!,
      effect,
      description: `The ${id} tool.`,
      inputSchema: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
      source: 'builtin',
      effectConfirmed: true,
      enabled: true,
    },
    parse(input) {
      const q = (input as { q?: unknown } | null)?.q;
      return typeof q === 'string'
        ? { ok: true, value: { q } }
        : { ok: false, message: 'q: expected a string' };
    },
    async execute(input) {
      const start = Date.now();
      tool.calls.push(input);
      if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
      tool.spans.push([start, Date.now()]);
      return opts.result ? opts.result(input) : { answer: input.q };
    },
  };
  return tool;
}

/** The tool-result parts of the transcript's tool messages, in order. */
export function toolResults(messages: Array<{ content: StoredMessage }>) {
  return messages
    .filter((m) => m.content.role === 'tool')
    .flatMap(
      (m) =>
        m.content.content as Array<{
          toolCallId: string;
          toolName: string;
          output: { type: string; value: unknown };
        }>,
    );
}
