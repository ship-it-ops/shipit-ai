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
        purgeRequested: async () => {
          calls.push('purge');
          return purges() === 1 ? 3 : 0;
        },
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
        purgeRequested: async () => {
          attempts += 1;
          if (attempts === 1) throw new Error('connection refused');
          return 0;
        },
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
});
