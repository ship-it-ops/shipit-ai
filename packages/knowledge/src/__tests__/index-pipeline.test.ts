import { describe, it, expect, vi, afterEach } from 'vitest';
import { FakeEmbedder, TEXTS_PER_EMBEDDING_CALL, type Embedder } from '../embedder.js';
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
  /** Every keepClaim call, and what the next ones answer. */
  kept: Array<{ documentId: string; contentHash: string }> = [];
  stillClaimed = true;

  async existingChunkEmbeddings(documentId: string, _model: string) {
    return new Map(this.existing.get(documentId) ?? []);
  }
  async replaceChunks(
    documentId: string,
    chunks: StoredChunkInput[],
    meta: { indexedHash: string; indexVersion: number },
  ) {
    this.replaced.push({ documentId, chunks, meta });
    return true;
  }
  async markUnchanged(documentId: string) {
    this.unchanged.push(documentId);
  }
  async markSkipped(documentId: string) {
    this.skipped.push(documentId);
  }
  async keepClaim(documentId: string, contentHash: string) {
    this.kept.push({ documentId, contentHash });
    return this.stillClaimed;
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

  it('embeds the same text under two headings once per heading', async () => {
    const store = new MemoryIndexStore();
    const texts: string[] = [];
    const fake = new FakeEmbedder(8);
    const recording: Embedder = {
      model: fake.model,
      dimensions: 8,
      embedDocuments: (input) => {
        texts.push(...input);
        return fake.embedDocuments(input);
      },
      embedQuery: (text) => fake.embedQuery(text),
    };
    await indexDocument(
      deps(store, recording),
      row({
        kind: 'confluence_page',
        segments: [
          { key: 'a', headingPath: ['Alpha'], text: 'TBD' },
          { key: 'b', headingPath: ['Beta'], text: 'TBD' },
        ],
      }),
    );
    const chunks = store.replaced[0]!.chunks;
    expect(texts).toEqual(['T › Alpha\nTBD', 'T › Beta\nTBD']);
    expect(chunks[0]!.textHash).not.toBe(chunks[1]!.textHash);
    expect(chunks[0]!.embedding).not.toBe(chunks[1]!.embedding);
  });

  it('embeds again when only the prefix changed (a rename)', async () => {
    const store = new MemoryIndexStore();
    const embedder = new FakeEmbedder(8);
    const page = (title: string) =>
      row({
        kind: 'confluence_page',
        title,
        contentHash: `h-${title}`,
        segments: [{ key: 'a', headingPath: ['Rollback'], text: 'drain the node first' }],
      });
    await indexDocument(deps(store, embedder), page('Runbook'));
    store.existing.set(
      'doc-1',
      new Map(store.replaced[0]!.chunks.map((c) => [c.textHash, c.embedding])),
    );
    embedder.calls = 0;
    await indexDocument(deps(store, embedder), page('Payments runbook'));
    expect(embedder.calls).toBe(1);
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

  // The worker aborts this signal when it is asked to stop, so an embedding
  // call in flight ends instead of holding the shutdown.
  it('hands the stop signal to the embedder', async () => {
    const seen: Array<{ title?: string; signal?: AbortSignal } | undefined> = [];
    const embedder: Embedder = {
      model: 'm',
      dimensions: 8,
      async embedDocuments(texts, options) {
        seen.push(options);
        return texts.map(() => new Array<number>(8).fill(0.1));
      },
      async embedQuery() {
        return new Array<number>(8).fill(0.1);
      },
    };
    const controller = new AbortController();
    await indexDocument(deps(new MemoryIndexStore(), embedder), row(), controller.signal);
    expect(seen).toEqual([{ title: 'T', signal: controller.signal }]);
  });

  // One embedding call takes a hundred texts and has its own deadline, so how
  // long a document takes grows with its length. What is sized for one call
  // (the reclaim of a stale claim, the worker's stall check, a retry) must
  // then work a call at a time too.
  describe('a document with more chunks than one embedding call takes', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    // One chunk per heading.
    const long = (sections: number): DocumentRow =>
      row({
        kind: 'confluence_page',
        segments: Array.from({ length: sections }, (_, i) => ({
          key: `s${i}`,
          headingPath: [`Section ${i}`],
          text: `what section ${i} says`,
        })),
      });

    /** Records the size of every call; `failing` makes the nth call (from 1) fail once. */
    function counting(failing?: { call: number; error: unknown }) {
      const fake = new FakeEmbedder(8);
      const sizes: number[] = [];
      const embedder: Embedder = {
        model: fake.model,
        dimensions: 8,
        async embedDocuments(texts) {
          sizes.push(texts.length);
          if (failing && sizes.length === failing.call) throw failing.error;
          return fake.embedDocuments(texts);
        },
        embedQuery: (text) => fake.embedQuery(text),
      };
      return { embedder, sizes, fake };
    }

    it('is embedded a call at a time, every chunk with its own vector', async () => {
      const store = new MemoryIndexStore();
      const { embedder, sizes, fake } = counting();
      const sections = 2 * TEXTS_PER_EMBEDDING_CALL + 50;
      expect(await indexDocument(deps(store, embedder), long(sections))).toBe('indexed');
      expect(sizes).toEqual([TEXTS_PER_EMBEDDING_CALL, TEXTS_PER_EMBEDDING_CALL, 50]);

      const { chunks } = store.replaced[0]!;
      expect(chunks).toHaveLength(sections);
      // The vectors of the second and third call landed on their own chunks.
      for (const at of [0, TEXTS_PER_EMBEDDING_CALL, sections - 1]) {
        const [vector] = await fake.embedDocuments([`${chunks[at]!.prefix}\n${chunks[at]!.text}`]);
        expect(chunks[at]!.embedding).toBe(`[${vector!.join(',')}]`);
      }
    });

    it('says between calls that it is still being worked on', async () => {
      const store = new MemoryIndexStore();
      const { embedder } = counting();
      let progress = 0;
      await indexDocument(
        deps(store, embedder),
        long(2 * TEXTS_PER_EMBEDDING_CALL + 1),
        undefined,
        () => void (progress += 1),
      );
      expect(store.kept).toEqual([
        { documentId: 'doc-1', contentHash: 'h1' },
        { documentId: 'doc-1', contentHash: 'h1' },
      ]);
      expect(progress).toBe(2);
    });

    it('says nothing of the kind for a document one call embeds', async () => {
      const store = new MemoryIndexStore();
      let progress = 0;
      await indexDocument(
        deps(store, counting().embedder),
        long(TEXTS_PER_EMBEDDING_CALL),
        undefined,
        () => void (progress += 1),
      );
      expect(store.kept).toEqual([]);
      expect(progress).toBe(0);
    });

    it('tries a call that failed again by itself, not the ones before it', async () => {
      vi.useFakeTimers();
      const store = new MemoryIndexStore();
      const { embedder, sizes } = counting({
        call: 2,
        error: Object.assign(new Error('unavailable'), { status: 503 }),
      });
      const indexing = indexDocument(deps(store, embedder), long(TEXTS_PER_EMBEDDING_CALL + 7));
      await vi.runAllTimersAsync();
      expect(await indexing).toBe('indexed');
      // The first hundred once; the last seven twice.
      expect(sizes).toEqual([TEXTS_PER_EMBEDDING_CALL, 7, 7]);
      expect(store.replaced[0]!.chunks).toHaveLength(TEXTS_PER_EMBEDDING_CALL + 7);
    });

    // The sink changed or removed the document while it was being embedded:
    // what is left of it would be thrown away at the end.
    it('stops when the document is no longer the claim it took', async () => {
      const store = new MemoryIndexStore();
      store.stillClaimed = false;
      const { embedder, sizes } = counting();
      expect(await indexDocument(deps(store, embedder), long(3 * TEXTS_PER_EMBEDDING_CALL))).toBe(
        'superseded',
      );
      expect(sizes).toEqual([TEXTS_PER_EMBEDDING_CALL]);
      expect(store.replaced).toEqual([]);
    });
  });
});
