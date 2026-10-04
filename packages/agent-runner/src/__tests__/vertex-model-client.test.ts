import { describe, it, expect } from 'vitest';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { AiModelConfig } from '@shipit-ai/shared';
import { VertexModelClient } from '../model/vertex-model-client.js';
import { ModelCallError, type ModelStepRequest } from '../model/model-client.js';

const gemini: AiModelConfig = {
  key: 'gemini',
  label: 'Gemini',
  family: 'gemini',
  modelId: 'gemini-3.8-flash',
  contextWindow: 1_048_576,
  tools: true,
};

const usage = (input: number, output: number, reasoning = 0, cacheRead = 0) => ({
  inputTokens: { total: input, noCache: input - cacheRead, cacheRead, cacheWrite: 0 },
  outputTokens: { total: output, text: output - reasoning, reasoning },
});

type GenerateResult = Awaited<ReturnType<MockLanguageModelV4['doGenerate']>>;

function clientReturning(result: Partial<GenerateResult> | (() => never)) {
  const mock = new MockLanguageModelV4({
    doGenerate:
      typeof result === 'function'
        ? result
        : async () => ({
            content: [],
            finishReason: { unified: 'stop', raw: 'STOP' },
            usage: usage(0, 0),
            warnings: [],
            ...result,
          }),
  });
  const client = new VertexModelClient({ resolveModel: () => mock });
  return { client, mock };
}

const request = (extra: Partial<ModelStepRequest> = {}): ModelStepRequest => ({
  model: gemini,
  instructions: 'You answer ownership questions.',
  messages: [{ role: 'user', content: 'Who owns payments-api?' }],
  tools: [
    {
      name: 'graph__find_owners',
      description: 'Find owners.',
      inputSchema: {
        type: 'object',
        properties: { entity: { type: 'string' } },
        required: ['entity'],
      },
    },
  ],
  signal: new AbortController().signal,
  ...extra,
});

describe('VertexModelClient.step', () => {
  it('returns a final answer as one assistant message with its usage', async () => {
    const { client } = clientReturning({
      content: [{ type: 'text', text: 'team-payments owns it.' }],
      usage: usage(120, 30, 10, 20),
    });
    const step = await client.step(request());
    expect(step.finish).toBe('stop');
    expect(step.text).toBe('team-payments owns it.');
    expect(step.toolCalls).toEqual([]);
    expect(step.usage).toEqual({ input: 120, output: 30, reasoning: 10, cacheRead: 20 });
    expect(step.messages).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'team-payments owns it.' }] },
    ]);
  });

  it('returns tool calls without running anything, keeping provider metadata on the message', async () => {
    const { client } = clientReturning({
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call_1',
          toolName: 'graph__find_owners',
          input: JSON.stringify({ entity: 'payments-api' }),
          providerMetadata: { google: { thoughtSignature: 'sig-abc' } },
        },
      ],
      finishReason: { unified: 'tool-calls', raw: 'STOP' },
      usage: usage(100, 20),
    });
    const step = await client.step(request());
    expect(step.finish).toBe('tool_calls');
    expect(step.toolCalls).toEqual([
      { callId: 'call_1', name: 'graph__find_owners', input: { entity: 'payments-api' } },
    ]);
    // The signature must survive in the stored message (probe finding,
    // docs/agent/investigations/vertex-model-layer-probe.md).
    expect(JSON.stringify(step.messages)).toContain('sig-abc');
  });

  it('hands a call to an undeclared tool to the caller instead of answering it itself', async () => {
    // Left alone, the SDK appends its own error result for such a call, which
    // would bypass the gateway and its audit row.
    const { client } = clientReturning({
      content: [
        {
          type: 'tool-call',
          toolCallId: 'call_9',
          toolName: 'graph__search_nodes',
          input: JSON.stringify({ q: 'x' }),
        },
      ],
      finishReason: { unified: 'tool-calls', raw: 'STOP' },
    });
    const step = await client.step(request());
    expect(step.toolCalls).toEqual([
      { callId: 'call_9', name: 'graph__search_nodes', input: { q: 'x' } },
    ]);
    expect(step.messages.map((m) => m.role)).toEqual(['assistant']);
  });

  it('sends the instructions, the transcript and the tool schemas, with no executors', async () => {
    const { client, mock } = clientReturning({ content: [{ type: 'text', text: 'ok' }] });
    await client.step(request());
    const call = mock.doGenerateCalls[0]!;
    expect(call.prompt[0]).toEqual({ role: 'system', content: 'You answer ownership questions.' });
    expect(call.prompt[1]).toMatchObject({ role: 'user' });
    expect(call.tools).toEqual([
      expect.objectContaining({
        type: 'function',
        name: 'graph__find_owners',
        inputSchema: expect.objectContaining({ required: ['entity'] }),
      }),
    ]);
  });

  it('passes a known effort through as the reasoning level and ignores an unknown one', async () => {
    const known = clientReturning({ content: [{ type: 'text', text: 'ok' }] });
    await known.client.step(request({ effort: 'high' }));
    expect(known.mock.doGenerateCalls[0]!.reasoning).toBe('high');

    const unknown = clientReturning({ content: [{ type: 'text', text: 'ok' }] });
    await unknown.client.step(request({ effort: 'turbo' }));
    expect(unknown.mock.doGenerateCalls[0]!.reasoning).toBeUndefined();
  });

  it('reports a content filter stop as a refusal', async () => {
    const { client } = clientReturning({
      content: [],
      finishReason: { unified: 'content-filter', raw: 'SAFETY' },
    });
    expect((await client.step(request())).finish).toBe('refusal');
  });

  it('reports a context-length rejection as CONTEXT_EXCEEDED', async () => {
    const { client } = clientReturning(() => {
      throw new APICallError({
        message:
          'The input token count (1200000) exceeds the maximum number of tokens allowed (1048576).',
        url: 'https://aiplatform.googleapis.com',
        requestBodyValues: {},
        statusCode: 400,
        isRetryable: false,
      });
    });
    await expect(client.step(request())).rejects.toMatchObject({
      name: 'ModelCallError',
      code: 'CONTEXT_EXCEEDED',
    });
  });

  it('reports any other provider failure as MODEL_ERROR', async () => {
    const { client } = clientReturning(() => {
      throw new APICallError({
        message: 'Quota exceeded',
        url: 'https://aiplatform.googleapis.com',
        requestBodyValues: {},
        statusCode: 429,
        isRetryable: false,
      });
    });
    const err = await client.step(request()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelCallError);
    expect(err).toMatchObject({ code: 'MODEL_ERROR', message: expect.stringContaining('Quota') });
  });

  it('stops when the signal aborts', async () => {
    const controller = new AbortController();
    controller.abort();
    const { client } = clientReturning({ content: [{ type: 'text', text: 'late' }] });
    await expect(client.step(request({ signal: controller.signal }))).rejects.toMatchObject({
      code: 'ABORTED',
    });
  });
});
