import { describe, it, expect } from 'vitest';
import { listenForWakeUps } from '../wake.js';

describe('listenForWakeUps', () => {
  it('returns at once while the subscribe is still pending (Redis down at boot)', () => {
    let listener: (() => void) | null = null;
    const subscriber = {
      subscribe: () => new Promise<unknown>(() => undefined), // never settles
      on: (_event: 'message', l: () => void) => (listener = l),
    };
    let woken = 0;

    // Synchronous: nothing to await, so the caller starts its loop regardless.
    const returned = listenForWakeUps(
      subscriber,
      'ch',
      () => (woken += 1),
      () => undefined,
    );

    expect(returned).toBeUndefined();
    listener!();
    expect(woken).toBe(1);
  });

  it('logs a failed subscribe instead of rejecting', async () => {
    const log: string[] = [];
    listenForWakeUps(
      { subscribe: () => Promise.reject(new Error('NOAUTH')), on: () => undefined },
      'ch',
      () => undefined,
      (l) => log.push(l),
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(log).toEqual(['could not subscribe to ch: NOAUTH']);
  });
});
