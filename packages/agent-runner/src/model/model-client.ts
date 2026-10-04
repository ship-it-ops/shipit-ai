// The one interface the run loop uses to call a model. Nothing outside
// src/model/ imports the AI SDK, so swapping a family to a direct SDK (the
// fallback the design keeps open for Claude) touches only this folder.
import type { StoredMessage } from '@shipit-ai/agents';
import type { AiModelConfig } from '@shipit-ai/shared';

export interface ModelToolSpec {
  /** The model-facing name, e.g. 'graph__find_owners'. */
  name: string;
  description: string;
  /** JSON Schema. Declared without an executor: the model only asks. */
  inputSchema: Record<string, unknown>;
}

export interface ModelStepRequest {
  model: AiModelConfig;
  instructions: string;
  /** The transcript as stored: model-layer message objects, metadata included. */
  messages: StoredMessage[];
  tools: ModelToolSpec[];
  /** The agent's effort setting; passed on as the reasoning level when valid. */
  effort?: string;
  signal: AbortSignal;
}

export type ModelFinish = 'stop' | 'tool_calls' | 'length' | 'refusal' | 'error';

export interface ModelToolCall {
  callId: string;
  name: string;
  input: unknown;
}

export interface ModelStepResult {
  /** What to append to the transcript: the assistant message(s), stored as-is. */
  messages: StoredMessage[];
  toolCalls: ModelToolCall[];
  text: string;
  finish: ModelFinish;
  usage: { input: number; output: number; reasoning?: number; cacheRead?: number };
}

export interface ModelClient {
  /** One model call. Tools are declared, never run here. */
  step(request: ModelStepRequest): Promise<ModelStepResult>;
}

export type ModelCallErrorCode = 'MODEL_ERROR' | 'CONTEXT_EXCEEDED' | 'ABORTED';

export class ModelCallError extends Error {
  constructor(
    readonly code: ModelCallErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ModelCallError';
  }
}
