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

  // One deadline for a whole document capped how many chunks a document may
  // have: a 200 kB file of short sections has thousands, and would fail every
  // attempt. Each slice gets its own.
  it('embeds a long document a hundred texts at a time, each slice with its own deadline', async () => {
    const { calls, embed } = fakeEmbed(8);
    const budgets: number[] = [];
    const e = embedder({
      embed,
      timeoutMs: (texts: number) => {
        budgets.push(texts);
        return 60_000;
      },
    });
    const texts = Array.from({ length: 250 }, (_, i) => `chunk ${i}`);
    const vectors = await e.embedDocuments(texts, { title: 'T' });
    expect(vectors).toHaveLength(250);
    expect(calls.map((c) => c.values.length)).toEqual([100, 100, 50]);
    expect(calls[2]!.values[0]).toBe('chunk 200');
    expect(calls.every((c) => c.title === 'T')).toBe(true);
    expect(budgets).toEqual([100, 100, 50]);
  });

  it('stops between slices when the caller aborts', async () => {
    const controller = new AbortController();
    const seen: number[] = [];
    const e = embedder({
      embed: async (call: EmbedCall) => {
        seen.push(call.values.length);
        controller.abort(new Error('worker stopping'));
        return call.values.map(() => new Array<number>(8).fill(0.1));
      },
    });
    const texts = Array.from({ length: 250 }, (_, i) => `chunk ${i}`);
    await expect(e.embedDocuments(texts, { signal: controller.signal })).rejects.toThrow(
      'worker stopping',
    );
    expect(seen).toEqual([100]);
  });

  // The stop signal lives as long as the worker. A listener left on it by
  // every call would be kept for just as long.
  it('leaves nothing attached to the caller’s signal after a call', async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    let attached = 0;
    const add = signal.addEventListener.bind(signal);
    const remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<typeof add>) => {
      attached += 1;
      return add(...args);
    }) as typeof signal.addEventListener;
    signal.removeEventListener = ((...args: Parameters<typeof remove>) => {
      attached -= 1;
      return remove(...args);
    }) as typeof signal.removeEventListener;

    const { embed } = fakeEmbed(8);
    await embedder({ embed }).embedDocuments(['a', 'b'], { signal });
    expect(attached).toBe(0);
  });
});
