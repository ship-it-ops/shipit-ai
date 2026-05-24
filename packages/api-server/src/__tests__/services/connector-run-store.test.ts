import { describe, it, expect, beforeEach } from 'vitest';
import type { LastRun } from '@shipit-ai/shared';
import { InMemoryConnectorRunStore, MAX_RUNS } from '../../services/connector-run-store.js';

// The Redis-backed store is exercised end-to-end against a live Redis
// instance during the connector-routes integration tests; the unit tests
// here pin down the *semantics* the registry depends on, which the
// in-memory and Redis implementations share by contract.

function makeRun(seq: number, status: LastRun['status'] = 'success'): LastRun {
  return {
    startedAt: new Date(2026, 0, 1, 0, seq).toISOString(),
    durationMs: 100 + seq,
    status,
    entitiesSynced: 10 + seq,
    errors: [],
  };
}

describe('InMemoryConnectorRunStore', () => {
  let store: InMemoryConnectorRunStore;

  beforeEach(() => {
    store = new InMemoryConnectorRunStore();
  });

  it('returns an empty array for an unknown connector', async () => {
    const runs = await store.listRuns('never-recorded');
    expect(runs).toEqual([]);
  });

  it('records a run and reads it back', async () => {
    const run = makeRun(1);
    await store.recordRun('c1', run);
    const runs = await store.listRuns('c1');
    expect(runs).toEqual([run]);
  });

  it('orders runs newest-first across multiple writes', async () => {
    // The registry's old YAML code prepended each run to the array; the
    // store has to preserve that contract or the UI's `lastRuns[0] = last
    // sync` derivation would silently invert.
    await store.recordRun('c1', makeRun(1));
    await store.recordRun('c1', makeRun(2));
    await store.recordRun('c1', makeRun(3));
    const runs = await store.listRuns('c1');
    expect(runs.map((r) => r.entitiesSynced)).toEqual([13, 12, 11]);
  });

  it(`caps history at MAX_RUNS=${MAX_RUNS}, dropping oldest`, async () => {
    for (let i = 0; i < MAX_RUNS + 5; i++) {
      await store.recordRun('c1', makeRun(i));
    }
    const runs = await store.listRuns('c1', MAX_RUNS + 5);
    expect(runs.length).toBe(MAX_RUNS);
    // Newest first → the most recent 20 of the 25 we pushed.
    expect(runs[0]?.entitiesSynced).toBe(10 + (MAX_RUNS + 4));
    expect(runs[runs.length - 1]?.entitiesSynced).toBe(10 + 5);
  });

  it('honors the limit argument', async () => {
    for (let i = 0; i < 5; i++) await store.recordRun('c1', makeRun(i));
    expect((await store.listRuns('c1', 2)).length).toBe(2);
    expect((await store.listRuns('c1', 0)).length).toBe(0);
  });

  it('caps the limit argument at MAX_RUNS', async () => {
    for (let i = 0; i < 3; i++) await store.recordRun('c1', makeRun(i));
    // Asking for more than MAX_RUNS shouldn't break; should return what
    // we have (capped at MAX_RUNS implicitly).
    const runs = await store.listRuns('c1', MAX_RUNS * 10);
    expect(runs.length).toBe(3);
  });

  it('keeps run history separate per connector', async () => {
    await store.recordRun('c1', makeRun(1));
    await store.recordRun('c2', makeRun(99, 'failed'));
    expect((await store.listRuns('c1'))[0]?.status).toBe('success');
    expect((await store.listRuns('c2'))[0]?.status).toBe('failed');
  });

  it('clear() drops all history for one connector', async () => {
    await store.recordRun('c1', makeRun(1));
    await store.recordRun('c2', makeRun(2));
    await store.clear('c1');
    expect(await store.listRuns('c1')).toEqual([]);
    expect((await store.listRuns('c2')).length).toBe(1);
  });

  it('listManyLatest pipelines reads and preserves input order', async () => {
    await store.recordRun('c1', makeRun(1));
    await store.recordRun('c1', makeRun(2));
    await store.recordRun('c2', makeRun(99));
    const out = await store.listManyLatest(['c2', 'c1', 'c3']);
    expect(Object.keys(out)).toEqual(['c2', 'c1', 'c3']);
    expect(out.c2?.length).toBe(1);
    expect(out.c1?.length).toBe(2);
    expect(out.c3).toEqual([]);
  });
});
