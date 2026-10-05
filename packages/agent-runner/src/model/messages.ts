// Builders for the transcript messages the loop writes itself. They use the AI
// SDK's message shape, which is what run_messages stores and replays.
import type { StoredMessage } from '@shipit-ai/agents';

export function userMessage(text: string): StoredMessage {
  return { role: 'user', content: text };
}

/**
 * One tool message carrying every result of a step, in the order the model
 * made the calls. Gemini rejects a transcript where a step's results are split
 * or reordered, so the loop only appends this once every call is resolved.
 */
export function toolResultMessage(
  results: ReadonlyArray<{ callId: string; name: string; output: unknown }>,
): StoredMessage {
  return {
    role: 'tool',
    content: results.map((r) => ({
      type: 'tool-result',
      toolCallId: r.callId,
      toolName: r.name,
      output: { type: 'json', value: r.output ?? null },
    })),
  };
}

export const STEP_LIMIT_NOTE =
  'This is your last step: you cannot call tools any more. Answer now with what you have found, and say what you could not check.';

/**
 * The note the loop adds before a run's last model step. It goes in the
 * transcript as a user message, because on long transcripts Gemini heeds a
 * trailing message and ignores the same words in the instructions (measured
 * live, 2026-10-03). The `shipit` provider options tag it for display; model
 * providers ignore keys that are not theirs.
 */
export function stepLimitNote(): StoredMessage {
  return {
    role: 'user',
    content: STEP_LIMIT_NOTE,
    providerOptions: { shipit: { kind: 'step-limit-note' } },
  };
}

export function isStepLimitNote(message: StoredMessage | undefined): boolean {
  const options = message?.providerOptions as { shipit?: { kind?: string } } | undefined;
  return options?.shipit?.kind === 'step-limit-note';
}
