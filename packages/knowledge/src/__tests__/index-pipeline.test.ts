import { describe, it, expect } from 'vitest';
import { FakeEmbedder, type Embedder } from '../embedder.js';
import { indexDocument, type IndexStore } from '../index-pipeline.js';
import type { DocumentRow, StoredChunkInput } from '../store.js';

class MemoryIndexStore implements IndexStore {
  existing = new Map<string, Map<string, string>>(); // documentId → textHash → embedding literal
  replaced: Array<{
    documentId: string;
    chunks: StoredChunkInput[];
    meta: { indexedHash: string; indexVersion: number };
  }> = [];
  unchanged: string[] = [];
  skipped: string[] = [];

  async existingChunkEmbeddings(documentId: string, _model: string) {
    return new Map(this.existing.get(documentId) ?? []);
  }
  async replaceChunks(
    documentId: string,
    chunks: StoredChunkInput[],
    meta: { indexedHash: string; indexVersion: number },
  ) {
    this.replaced.push({ documentId, chunks, meta });
  }
  async markUnchanged(documentId: string) {
    this.unchanged.push(documentId);
  }
  async markSkipped(documentId: string) {
    this.skipped.push(documentId);
  }
}

function row(overrides: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: 'doc-1',
    connectorId: 'c',
    containerId: 'cont-1',
    externalId: 'x',
    kind: 'slack_thread',
    title: 'T',
    url: 'https://e/x',
    segments: [
      { key: '1', authorName: 'Ada', at: '2026-01-01T09:00:00Z', text: 'payments api is down' },
      { key: '2', authorName: 'Bob', at: '2026-01-01T09:01:00Z', text: 'rolling back now' },
    ],
    contentHash: 'h1',
    sourceVersion: 'v',
    sourceCreatedAt: null,
    sourceUpdatedAt: null,
    authorPrincipalId: null,
    participantPrincipalIds: [],
    state: null,
    attributes: {},
    restricted: false,
    redactions: 0,
    indexStatus: 'indexing',
    indexAttempts: 0,
    indexError: null,
    indexedHash: null,
    indexVersion: null,
    deletedAt: null,
    ...overrides,
  };
}

const deps = (store: MemoryIndexStore, embedder: Embedder = new FakeEmbedder(8)) => ({
  store,
  embedder,
  chunking: { chunkTokens: 600, maxChunkTokens: 800 },
  indexVersion: 1,
  containerNameOf: async () => 'general',
});

describe('indexDocument', () => {
  it('chunks, embeds and replaces, then marks the content hash as indexed', async () => {
    const store = new MemoryIndexStore();
    const embedder = new FakeEmbedder(8);
    expect(await indexDocument(deps(store, embedder), row())).toBe('indexed');
    expect(store.replaced).toHaveLength(1);
    const { chunks, meta } = store.replaced[0]!;
    expect(meta).toEqual({ indexedHash: 'h1', indexVersion: 1 });
    expect(chunks[0]!.embeddingModel).toBe('fake-embedding');
    expect(chunks[0]!.embedding.startsWith('[')).toBe(true);
    expect(chunks[0]!.prefix).toContain('#general');
    expect(embedder.calls).toBe(1);
  });

  it('skips a deleted, restricted or empty document', async () => {
    const store = new MemoryIndexStore();
    expect(await indexDocument(deps(store), row({ deletedAt: '2026-01-01T00:00:00Z' }))).toBe(
      'skipped',
    );
    expect(await indexDocument(deps(store), row({ restricted: true, segments: [] }))).toBe(
      'skipped',
    );
    expect(await indexDocument(deps(store), row({ segments: [] }))).toBe('skipped');
    expect(store.skipped).toEqual(['doc-1', 'doc-1', 'doc-1']);
    expect(store.replaced).toHaveLength(0);
  });

  it('reports unchanged when the hash and index version match, without embedding', async () => {
    const store = new MemoryIndexStore();
    const embedder = new FakeEmbedder(8);
    expect(
      await indexDocument(deps(store, embedder), row({ indexedHash: 'h1', indexVersion: 1 })),
    ).toBe('unchanged');
    expect(store.unchanged).toEqual(['doc-1']);
    expect(embedder.calls).toBe(0);
  });

  it('re-indexes when the index version moved even if the hash matches', async () => {
    const store = new MemoryIndexStore();
    expect(
      await indexDocument(
        { ...deps(store), indexVersion: 2 },
        row({ indexedHash: 'h1', indexVersion: 1 }),
      ),
    ).toBe('indexed');
  });

  it('reuses embeddings for chunks whose text did not change', async () => {
    const store = new MemoryIndexStore();
    const embedder = new FakeEmbedder(8);
    await indexDocument(deps(store, embedder), row());
    const first = store.replaced[0]!.chunks;
    store.existing.set('doc-1', new Map(first.map((c) => [c.textHash, c.embedding])));

    // A reply arrives: the thread still fits one chunk, so its text changes and
    // one embedding call happens.
    const doc = row({
      contentHash: 'h2',
      segments: [
        ...row().segments,
        { key: '3', authorName: 'Ada', at: '2026-01-01T09:02:00Z', text: 'fixed' },
      ],
    });
    embedder.calls = 0;
    await indexDocument(deps(store, embedder), doc);
    expect(embedder.calls).toBe(1);

    // Same content again: every chunk hash is known → zero embedding calls.
    store.existing.set(
      'doc-1',
      new Map(store.replaced.at(-1)!.chunks.map((c) => [c.textHash, c.embedding])),
    );
    embedder.calls = 0;
    await indexDocument(deps(store, embedder), { ...doc, indexedHash: null });
    expect(embedder.calls).toBe(0);
  });

  it('fails loudly when the embedder returns vectors of a different dimension than it claims', async () => {
    const store = new MemoryIndexStore();
    // Claims 8 dimensions, returns 7: the pipeline must not store it.
    const seven = new FakeEmbedder(7);
    const lying = {
      model: seven.model,
      dimensions: 8,
      embedDocuments: (texts: string[]) => seven.embedDocuments(texts),
      embedQuery: (text: string) => seven.embedQuery(text),
    };
    await expect(indexDocument(deps(store, lying), row())).rejects.toThrow(/expected 8/);
    expect(store.replaced).toHaveLength(0);
  });
});
