import { describe, it, expect } from 'vitest';
import {
  STEP_LIMIT_NOTE,
  isStepLimitNote,
  stepLimitNote,
  toolResultMessage,
  userMessage,
} from '../model/messages.js';

describe('transcript messages', () => {
  it('builds a user message from text', () => {
    expect(userMessage('Who owns payments-api?')).toEqual({
      role: 'user',
      content: 'Who owns payments-api?',
    });
  });

  it('puts every result of a step in one tool message, in call order', () => {
    expect(
      toolResultMessage([
        { callId: 'c1', name: 'graph__find_owners', output: { owners: ['team-a'] } },
        {
          callId: 'c2',
          name: 'graph__graph_stats',
          output: { error: { code: 'X', message: 'y' } },
        },
      ]),
    ).toEqual({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'c1',
          toolName: 'graph__find_owners',
          output: { type: 'json', value: { owners: ['team-a'] } },
        },
        {
          type: 'tool-result',
          toolCallId: 'c2',
          toolName: 'graph__graph_stats',
          output: { type: 'json', value: { error: { code: 'X', message: 'y' } } },
        },
      ],
    });
  });

  it('stores an undefined output as null, which JSON can carry', () => {
    const message = toolResultMessage([{ callId: 'c1', name: 't', output: undefined }]);
    expect(JSON.parse(JSON.stringify(message))).toEqual(message);
  });

  it('builds the last-step note as a tagged user message, and recognises it', () => {
    const note = stepLimitNote();
    expect(note).toEqual({
      role: 'user',
      content: STEP_LIMIT_NOTE,
      providerOptions: { shipit: { kind: 'step-limit-note' } },
    });
    expect(isStepLimitNote(note)).toBe(true);
    expect(isStepLimitNote(userMessage(STEP_LIMIT_NOTE))).toBe(false);
  });
});
