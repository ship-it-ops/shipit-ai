import { describe, it, expect } from 'vitest';
import { VertexEmbedder, type EmbedCall } from '../vertex-embedder.js';

function fakeEmbed(dimensions: number) {
  const calls: EmbedCall[] = [];
  const embed = async (call: EmbedCall) => {
    calls.push(call);
    return call.values.map(() => new Array<number>(dimensions).fill(0.1));
  };
  return { calls, embed };
}

describe('VertexEmbedder', () => {
  it('sends documents with RETRIEVAL_DOCUMENT, the title and the dimension', async () => {
    const { calls, embed } = fakeEmbed(768);
    const e = new VertexEmbedder({
      project: 'p',
      location: 'global',
      model: 'gemini-embedding-2',
      dimensions: 768,
      embed,
    });
    const out = await e.embedDocuments(['a', 'b'], { title: 'T' });
    expect(out).toHaveLength(2);
    expect(calls[0]).toEqual({
      model: 'gemini-embedding-2',
      values: ['a', 'b'],
      taskType: 'RETRIEVAL_DOCUMENT',
      outputDimensionality: 768,
      title: 'T',
      maxParallelCalls: 4,
      signal: expect.any(AbortSignal),
    });
  });

  it('sends queries with RETRIEVAL_QUERY and no title', async () => {
    const { calls, embed } = fakeEmbed(768);
    const e = new VertexEmbedder({
      project: 'p',
      location: 'global',
      model: 'm',
      dimensions: 768,
      embed,
    });
    await e.embedQuery('q');
    expect(calls[0]!.taskType).toBe('RETRIEVAL_QUERY');
    expect(calls[0]!.title).toBeUndefined();
  });

  it('caps parallel requests at the configured concurrency', async () => {
    const { calls, embed } = fakeEmbed(768);
    const e = new VertexEmbedder({
      project: 'p',
      location: 'global',
      model: 'm',
      dimensions: 768,
      maxParallelCalls: 2,
      embed,
    });
    await e.embedDocuments(['a']);
    expect(calls[0]!.maxParallelCalls).toBe(2);
  });

  it('rejects vectors of the wrong dimension', async () => {
    const { embed } = fakeEmbed(3);
    const e = new VertexEmbedder({
      project: 'p',
      location: 'global',
      model: 'm',
      dimensions: 768,
      embed,
    });
    await expect(e.embedDocuments(['a'])).rejects.toThrow(/expected 768/);
  });

  const embedder = (extra: Record<string, unknown>) =>
    new VertexEmbedder({
      project: 'p',
      location: 'global',
      model: 'gemini-embedding-2',
      dimensions: 8,
      ...extra,
    });
  // A request the model never answers: it ends only when its signal aborts.
  const neverAnswers = (call: EmbedCall): Promise<number[][]> =>
    new Promise((_resolve, reject) => {
      call.signal.addEventListener('abort', () => reject(call.signal.reason));
    });

  it('gives every call a signal, live until its deadline', async () => {
    const { calls, embed } = fakeEmbed(8);
    await embedder({ embed }).embedDocuments(['a']);
    expect(calls[0]!.signal).toBeInstanceOf(AbortSignal);
    expect(calls[0]!.signal.aborted).toBe(false);
  });

  // One stalled request would otherwise hold its document, and with it a slot
  // of the index loop, for as long as the HTTP client is willing to wait.
  it('fails a call that outlives its deadline, and says so', async () => {
    const e = embedder({ embed: neverAnswers, timeoutMs: (texts: number) => 10 * texts });
    await expect(e.embedDocuments(['a', 'b'])).rejects.toThrow(
      'Embedding 2 texts took longer than 20 ms',
    );
    await expect(e.embedQuery('q')).rejects.toThrow('Embedding 1 text took longer than 10 ms');
  });

  it('allows more time for more texts by default', async () => {
    const { calls, embed } = fakeEmbed(8);
    const seen: number[] = [];
    const e = embedder({
      embed,
      timeoutMs: (texts: number) => {
        seen.push(texts);
        return 60_000;
      },
    });
    await e.embedDocuments(['a', 'b', 'c']);
    expect(seen).toEqual([3]);
    expect(calls).toHaveLength(1);
  });

  it('ends a call when the caller aborts, with the caller’s reason', async () => {
    const controller = new AbortController();
    const pending = embedder({ embed: neverAnswers }).embedDocuments(['a'], {
      signal: controller.signal,
    });
    controller.abort(new Error('worker stopping'));
    await expect(pending).rejects.toThrow('worker stopping');
  });
});
