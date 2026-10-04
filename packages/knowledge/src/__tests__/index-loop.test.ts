import { describe, it, expect } from 'vitest';
import { FakeEmbedder } from '../embedder.js';
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
});
