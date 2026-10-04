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
});
