/**
 * Redis-BACKED integration test for RedisConnectorRunStore (#10).
 *
 * The unit suite only tests InMemoryConnectorRunStore — the real Redis impl
 * (LPUSH/LTRIM FIFO cap, LRANGE, the pipeline `[err, value]` tuple parsing in
 * listManyLatest) has ZERO coverage. This runs it against real Redis.
 *
 * Gated on REDIS_TEST_URL (skips by default → unit run stays Docker-free).
 * Uses unique connector ids + clears them, so it's safe against a shared Redis.
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { Redis } from 'ioredis';
import type { LastRun } from '@shipit-ai/shared';
import {
  RedisConnectorRunStore,
  MAX_RUNS,
  KEY_PREFIX,
} from '../../services/connector-run-store.js';

const URL = process.env.REDIS_TEST_URL;
const RUN = `itest-${process.pid}-${Math.floor(performance.now())}`;
const cid = (n: string) => `${RUN}-${n}`;

const lastRun = (n: number): LastRun => ({
  startedAt: `2026-06-19T00:00:${String(n).padStart(2, '0')}Z`,
  durationMs: n,
  status: 'success',
  entitiesSynced: n,
  errors: [],
});

describe.skipIf(!URL)('RedisConnectorRunStore — Redis integration', () => {
  let redis: Redis;
  let store: RedisConnectorRunStore;

  beforeAll(() => {
    redis = new Redis(URL!, { maxRetriesPerRequest: null });
    store = new RedisConnectorRunStore(redis);
  });

  afterEach(async () => {
    const keys = await redis.keys(`${KEY_PREFIX}${RUN}-*`);
    if (keys.length) await redis.del(...keys);
  });

  afterAll(() => {
    redis.disconnect();
  });

  it('records newest-first and caps the list at MAX_RUNS (LPUSH + LTRIM)', async () => {
    for (let i = 1; i <= MAX_RUNS + 5; i++) await store.recordRun(cid('a'), lastRun(i));
    const runs = await store.listRuns(cid('a'));
    expect(runs).toHaveLength(MAX_RUNS);
    // newest (highest i) first
    expect(runs[0].durationMs).toBe(MAX_RUNS + 5);
    expect(runs[runs.length - 1].durationMs).toBe(6); // oldest kept after trim
  });

  it('listRuns honors the limit and returns [] for an unknown connector', async () => {
    await store.recordRun(cid('b'), lastRun(1));
    await store.recordRun(cid('b'), lastRun(2));
    expect(await store.listRuns(cid('b'), 1)).toHaveLength(1);
    expect(await store.listRuns(cid('absent'))).toEqual([]);
  });

  it('listManyLatest pipelines multiple connectors and tolerates empties', async () => {
    await store.recordRun(cid('c1'), lastRun(7));
    await store.recordRun(cid('c2'), lastRun(8));
    const out = await store.listManyLatest([cid('c1'), cid('c2'), cid('c3-empty')]);
    expect(out[cid('c1')][0].durationMs).toBe(7);
    expect(out[cid('c2')][0].durationMs).toBe(8);
    expect(out[cid('c3-empty')]).toEqual([]);
  });

  it('clear removes the connector run history', async () => {
    await store.recordRun(cid('d'), lastRun(1));
    expect(await store.listRuns(cid('d'))).toHaveLength(1);
    await store.clear(cid('d'));
    expect(await store.listRuns(cid('d'))).toEqual([]);
  });
});
