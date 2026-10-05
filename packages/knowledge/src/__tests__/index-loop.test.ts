import { describe, it, expect, vi, afterEach } from 'vitest';
import { FakeEmbedder, TEXTS_PER_EMBEDDING_CALL, type Embedder } from '../embedder.js';
import { IndexLoop } from '../index-loop.js';
import type { DocumentRow, KnowledgeStore } from '../store.js';

// The loop's timing behaviour, with the store faked: what it claims and when.
function fakeStore(claim: () => Promise<DocumentRow[]>): KnowledgeStore {
  return { claimPending: claim } as unknown as KnowledgeStore;
}

function loopOver(
  store: KnowledgeStore,
  extra: Partial<ConstructorParameters<typeof IndexLoop>[0]> = {},
) {
  return new IndexLoop({
    store,
    pipeline: {
      store,
      embedder: new FakeEmbedder(8),
      chunking: { chunkTokens: 600, maxChunkTokens: 800 },
      indexVersion: 1,
      containerNameOf: async () => 'general',
    },
    batchSize: 4,
    concurrency: 2,
    pollIntervalMs: 60_000, // never reached in these tests: only a wake-up moves the loop
    ...extra,
  });
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe('IndexLoop', () => {
  it('claims again at once when a wake-up arrived while a batch was running', async () => {
    let claims = 0;
    let release: () => void = () => undefined;
    const store = fakeStore(async () => {
      claims += 1;
      if (claims === 1) await new Promise<void>((r) => (release = r));
      return [];
    });
    const loop = loopOver(store);
    loop.start();
    await tick();
    expect(claims).toBe(1);

    loop.kick(); // the sink committed while the first claim was still in flight
    release();
    await tick();

    expect(claims).toBe(2);
    await loop.stop();
  });

  it('a wake-up cuts the wait short', async () => {
    let claims = 0;
    const loop = loopOver(fakeStore(async () => ((claims += 1), [])));
    loop.start();
    await tick();
    expect(claims).toBe(1);
    loop.kick();
    await tick();
    expect(claims).toBe(2);
    await loop.stop();
  });

  it('keeps going after a claim fails', async () => {
    let claims = 0;
    const log: string[] = [];
    const loop = loopOver(
      fakeStore(async () => {
        claims += 1;
        if (claims === 1) throw new Error('connection refused');
        return [];
      }),
      { log: (l) => log.push(l) },
    );
    loop.start();
    await tick();
    expect(log[0]).toContain('connection refused');
    loop.kick();
    await tick();
    expect(claims).toBe(2);
    await loop.stop();
  });

  it('heartbeats at start and stops when stopped', async () => {
    const beats: Array<{ key: string; ttl: number }> = [];
    const loop = loopOver(
      fakeStore(async () => []),
      {
        heartbeat: {
          sink: { set: async (key, _value, ttl) => void beats.push({ key, ttl }) },
          key: 'hb',
          ttlSeconds: 60,
          everyMs: 10,
        },
      },
    );
    loop.start();
    await new Promise((r) => setTimeout(r, 35));
    await loop.stop();
    const count = beats.length;
    expect(count).toBeGreaterThanOrEqual(2);
    expect(beats[0]).toEqual({ key: 'hb', ttl: 60 });
    await new Promise((r) => setTimeout(r, 30));
    expect(beats.length).toBe(count);
  });

  const document = (id: string): DocumentRow =>
    ({
      id,
      connectorId: 'c',
      containerId: 'cont-1',
      externalId: id,
      kind: 'slack_thread',
      title: 'T',
      url: 'https://e/x',
      segments: [{ key: '1', text: 'payments api is down' }],
      contentHash: 'h1',
      attributes: {},
      restricted: false,
      indexStatus: 'indexing',
      indexedHash: null,
      indexVersion: null,
      deletedAt: null,
    }) as unknown as DocumentRow;

  // An embedder whose call ends only when its signal is aborted, the way a
  // request to a model that has stopped answering does.
  const stalled = (): Embedder => ({
    model: 'm',
    dimensions: 8,
    embedDocuments: (_texts, options) =>
      new Promise((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    embedQuery: async () => [],
  });

  // Kubernetes gives a pod a grace period and then kills it. A stop that waits
  // for every claimed document outlasts it, and the claims then sit for ten
  // minutes until the stale reclaim.
  it('stops at once: aborts what is in flight and hands every claimed document back', async () => {
    const released: string[] = [];
    const failed: string[] = [];
    let claims = 0;
    const store = {
      claimPending: async () => (claims++ === 0 ? ['a', 'b', 'c'].map(document) : []),
      existingChunkEmbeddings: async () => new Map<string, string>(),
      releaseClaim: async (id: string) => void released.push(id),
      markFailed: async (id: string) => void failed.push(id),
    } as unknown as KnowledgeStore;
    const loop = new IndexLoop({
      store,
      pipeline: {
        store,
        embedder: stalled(),
        chunking: { chunkTokens: 600, maxChunkTokens: 800 },
        indexVersion: 1,
        containerNameOf: async () => 'general',
      },
      batchSize: 4,
      concurrency: 1,
      pollIntervalMs: 60_000,
    });
    loop.start();
    await tick(); // 'a' is embedding; 'b' and 'c' wait their turn

    await loop.stop();

    expect(released.sort()).toEqual(['a', 'b', 'c']);
    // Being stopped is not the document failing: no attempt is spent on it.
    expect(failed).toEqual([]);
  });

  it('says what each batch did', async () => {
    const log: string[] = [];
    let claims = 0;
    const store = {
      claimPending: async () => (claims++ === 0 ? [document('a')] : []),
      existingChunkEmbeddings: async () => new Map<string, string>(),
      replaceChunks: async () => true,
    } as unknown as KnowledgeStore;
    const loop = new IndexLoop({
      store,
      pipeline: {
        store,
        embedder: new FakeEmbedder(8),
        chunking: { chunkTokens: 600, maxChunkTokens: 800 },
        indexVersion: 1,
        containerNameOf: async () => 'general',
      },
      batchSize: 4,
      concurrency: 2,
      pollIntervalMs: 60_000,
      log: (line) => log.push(line),
    });
    loop.start();
    await tick();
    await loop.stop();
    expect(log).toEqual([
      expect.stringMatching(/^batch: 1 claimed, 1 indexed, .*0 failed, in \d+ ms$/),
    ]);
  });

  // The heartbeat is what the status check reads for "worker". On its own
  // timer it keeps saying healthy while the loop is wedged.
  it('stops writing the heartbeat when the loop has made no progress for too long', async () => {
    const beats: number[] = [];
    const loop = loopOver(
      fakeStore(() => new Promise<DocumentRow[]>(() => {})), // the claim never answers
      {
        heartbeat: {
          sink: { set: async () => void beats.push(Date.now()) },
          key: 'hb',
          ttlSeconds: 60,
          everyMs: 10,
          stallAfterMs: 30,
        },
      },
    );
    loop.start();
    await new Promise((r) => setTimeout(r, 120));
    const count = beats.length;
    expect(count).toBeGreaterThanOrEqual(1);
    expect(count).toBeLessThanOrEqual(5);
    await new Promise((r) => setTimeout(r, 60));
    expect(beats.length).toBe(count);
  });

  // A long document is embedded a call at a time. Each call that comes back
  // is progress: without that, a worker halfway through a large file would
  // look wedged, and be restarted, on every attempt.
  describe('with a document that takes several embedding calls', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('goes on writing the heartbeat as each call comes back', async () => {
      vi.useFakeTimers();
      const beats: number[] = [];
      // Each embedding call answers only when the test lets it.
      const pending: Array<() => void> = [];
      const fake = new FakeEmbedder(8);
      const embedder: Embedder = {
        model: fake.model,
        dimensions: 8,
        embedDocuments: (texts) =>
          new Promise((resolve) => pending.push(() => resolve(fake.embedDocuments(texts)))),
        embedQuery: (text) => fake.embedQuery(text),
      };
      const long = {
        ...document('d1'),
        kind: 'confluence_page',
        segments: Array.from({ length: 2 * TEXTS_PER_EMBEDDING_CALL }, (_, i) => ({
          key: `s${i}`,
          headingPath: [`Section ${i}`],
          text: `what section ${i} says`,
        })),
      } as DocumentRow;
      let claims = 0;
      const store = {
        claimPending: async () => (claims++ === 0 ? [long] : []),
        existingChunkEmbeddings: async () => new Map(),
        keepClaim: async () => true,
        replaceChunks: async () => true,
      } as unknown as KnowledgeStore;
      const loop = loopOver(store, {
        pipeline: {
          store,
          embedder,
          chunking: { chunkTokens: 600, maxChunkTokens: 800 },
          indexVersion: 1,
          containerNameOf: async () => 'general',
        },
        heartbeat: {
          sink: { set: async () => void beats.push(Date.now()) },
          key: 'hb',
          ttlSeconds: 60,
          everyMs: 10,
          stallAfterMs: 30,
        },
      });
      loop.start();
      // The first call does not answer for longer than the stall threshold.
      await vi.advanceTimersByTimeAsync(100);
      const whileStalled = beats.length;
      await vi.advanceTimersByTimeAsync(50);
      expect(beats.length).toBe(whileStalled);

      // It answers; the document is not finished, and that is progress.
      expect(pending).toHaveLength(1);
      pending.shift()!();
      await vi.advanceTimersByTimeAsync(20);
      expect(beats.length).toBeGreaterThan(whileStalled);

      pending.shift()!();
      await vi.advanceTimersByTimeAsync(20);
      await loop.stop();
    });
  });

  it('keeps the heartbeat while it waits for work, however long that is', async () => {
    const beats: number[] = [];
    const loop = loopOver(
      fakeStore(async () => []),
      {
        heartbeat: {
          sink: { set: async () => void beats.push(Date.now()) },
          key: 'hb',
          ttlSeconds: 60,
          everyMs: 10,
          stallAfterMs: 30,
        },
      },
    );
    loop.start();
    await new Promise((r) => setTimeout(r, 120));
    await loop.stop();
    expect(beats.length).toBeGreaterThanOrEqual(8);
  });
});
