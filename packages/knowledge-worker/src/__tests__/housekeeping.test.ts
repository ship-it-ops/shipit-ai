import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { startHousekeeping } from '../housekeeping.js';

// Fake timers: the chores run on a one-minute and a one-day interval, and the
// test decides when a minute has passed.
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const MINUTE = 60_000;

describe('startHousekeeping', () => {
  it('purges deselected containers every minute and removes old tombstones at start', async () => {
    const calls: string[] = [];
    const log: string[] = [];
    const purges = (): number => calls.filter((c) => c === 'purge').length;
    const housekeeping = startHousekeeping({
      store: {
        purgeBatch: async () => {
          calls.push('purge');
          return purges() === 1 ? { containers: 1, documents: 3 } : { containers: 0, documents: 0 };
        },
        sweepUnusedPrincipals: async () => 0,
        deleteTombstonesOlderThan: async (days: number) => {
          calls.push(`tombstones:${days}`);
          return 0;
        },
      },
      tombstoneDays: 30,
      log: (line) => log.push(line),
    });

    await vi.advanceTimersByTimeAsync(0); // what it does at start
    expect(calls).toEqual(['tombstones:30', 'purge']);
    // Only the purge that deleted something is worth a log line.
    expect(log).toEqual(['purged 3 document(s)']);

    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(purges()).toBe(2);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(purges()).toBe(3);
    expect(calls.filter((c) => c.startsWith('tombstones'))).toHaveLength(1); // daily, not yet

    housekeeping.stop();
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(purges()).toBe(3); // stopped: no call after stop()
  });

  it('logs a failing chore and tries again at the next tick', async () => {
    let attempts = 0;
    const errors: string[] = [];
    const housekeeping = startHousekeeping({
      store: {
        purgeBatch: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('connection refused');
          return { containers: 0, documents: 0 };
        },
        sweepUnusedPrincipals: async () => 0,
        deleteTombstonesOlderThan: async () => {
          throw new Error('statement timeout');
        },
      },
      tombstoneDays: 30,
      log: () => undefined,
      logError: (line) => errors.push(line),
    });

    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual([
      'tombstone cleanup failed: statement timeout',
      'purge failed: connection refused',
    ]);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(attempts).toBe(2);
    housekeeping.stop();
  });

  // One batch a minute made a deleted connector with a few hundred containers
  // take hours to disappear, with every other deselect queued behind it.
  it('keeps purging within a tick until a batch comes back short', async () => {
    const batches = [20, 20, 7, 0];
    let calls = 0;
    const log: string[] = [];
    const housekeeping = startHousekeeping({
      store: {
        purgeBatch: async (limit?: number) => {
          expect(limit).toBe(20);
          const containers = batches[calls] ?? 0;
          calls += 1;
          return { containers, documents: containers * 2 };
        },
        sweepUnusedPrincipals: async () => 0,
        deleteTombstonesOlderThan: async () => 0,
      },
      tombstoneDays: 30,
      log: (line) => log.push(line),
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(3); // 20, 20, then 7: fewer than a full batch, so it is done
    expect(log).toEqual(['purged 94 document(s)']);
    housekeeping.stop();
  });

  it('gives up for this tick after a bounded number of batches', async () => {
    let calls = 0;
    const housekeeping = startHousekeeping({
      store: {
        purgeBatch: async () => {
          calls += 1;
          return { containers: 20, documents: 0 };
        },
        sweepUnusedPrincipals: async () => 0,
        deleteTombstonesOlderThan: async () => 0,
      },
      tombstoneDays: 30,
      log: () => undefined,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(50);
    housekeeping.stop();
  });

  // People are held only while something refers to them. A run that was in
  // flight when its connector was deleted can leave some behind.
  it('sweeps people nothing refers to on every tick', async () => {
    let sweeps = 0;
    const log: string[] = [];
    const housekeeping = startHousekeeping({
      store: {
        purgeBatch: async () => ({ containers: 0, documents: 0 }),
        sweepUnusedPrincipals: async () => {
          sweeps += 1;
          return sweeps === 1 ? 2 : 0;
        },
        deleteTombstonesOlderThan: async () => 0,
      },
      tombstoneDays: 30,
      log: (line) => log.push(line),
    });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(MINUTE);
    expect(sweeps).toBe(2);
    expect(log).toEqual(['removed 2 unused principal(s)']);
    housekeeping.stop();
  });
});
