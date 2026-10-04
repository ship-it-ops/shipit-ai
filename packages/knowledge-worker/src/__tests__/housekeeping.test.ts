import { describe, it, expect } from 'vitest';
import { startHousekeeping } from '../housekeeping.js';

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('startHousekeeping', () => {
  it('purges deselected containers on its interval and removes old tombstones at start', async () => {
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
      purgeEveryMs: 10,
      log: (line) => log.push(line),
    });
    await tick(45);
    housekeeping.stop();

    const seen = purges();
    expect(seen).toBeGreaterThanOrEqual(2);
    expect(calls).toContain('tombstones:30');
    // Only the purge that deleted something is worth a log line.
    expect(log).toEqual(['purged 3 document(s)']);

    await tick(40);
    expect(purges()).toBe(seen); // stopped: no call after stop()
  });

  it('logs a failing purge and keeps going', async () => {
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
      purgeEveryMs: 10,
      log: () => undefined,
      logError: (line) => errors.push(line),
    });
    await tick(45);
    housekeeping.stop();

    expect(errors).toContain('purge failed: connection refused');
    expect(errors).toContain('tombstone cleanup failed: statement timeout');
    expect(attempts).toBeGreaterThanOrEqual(2);
  });
});
