import type { ToolDescriptor } from '@shipit-ai/agents';

export type ParseResult =
  { ok: true; value: Record<string, unknown> } | { ok: false; message: string };

/** A tool the runner can offer a model: what it is, how to check input, how to run it. */
export interface RunnerTool {
  descriptor: ToolDescriptor;
  /** Validates the model's input and fills defaults. A failure goes back to the model. */
  parse(input: unknown): ParseResult;
  /**
   * Runs the tool on parsed input. A tool-level failure the model should see
   * (unknown node, guardrail) is returned as data; a throw means the tool
   * itself broke and is recorded as a failed call.
   */
  execute(input: Record<string, unknown>): Promise<unknown>;
}
