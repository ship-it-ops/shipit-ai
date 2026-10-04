// packages/connectors/github/src/knowledge/__tests__/rate-limit.test.ts
import { describe, it, expect } from 'vitest';
import { RunBudgetEnded, rateLimitWaitMs, withRateLimit } from '../rate-limit.js';

const limited = (headers: Record<string, string>, status = 403) =>
  Object.assign(new Error('rate limited'), { status, response: { headers } });

describe('rateLimitWaitMs', () => {
  it('reads Retry-After in seconds', () => {
    expect(rateLimitWaitMs(limited({ 'retry-after': '30' }, 429), 0)).toBe(30_000);
  });

  it('reads the reset time when the primary limit is spent', () => {
    const err = limited({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1000' });
    expect(rateLimitWaitMs(err, 990_000)).toBe(11_000); // to the reset, plus a second
  });

  it('is null for a 403 that is not a rate limit, and for other errors', () => {
    expect(rateLimitWaitMs(limited({ 'x-ratelimit-remaining': '4000' }), 0)).toBeNull();
    expect(rateLimitWaitMs(Object.assign(new Error('x'), { status: 500 }), 0)).toBeNull();
    expect(rateLimitWaitMs(null, 0)).toBeNull();
  });
});

describe('withRateLimit', () => {
  it('waits and tries again', async () => {
    let n = 0;
    const slept: number[] = [];
    const out = await withRateLimit(
      async () => {
        n += 1;
        if (n === 1) throw limited({ 'retry-after': '2' }, 429);
        return 'ok';
      },
      { deadline: 100_000 },
      { now: () => 0, sleep: async (ms) => void slept.push(ms) },
    );
    expect(out).toBe('ok');
    expect(slept).toEqual([2_000]);
  });

  it('ends the run when the wait does not fit before the deadline', async () => {
    await expect(
      withRateLimit(
        async () => {
          throw limited({ 'retry-after': '600' }, 429);
        },
        { deadline: 60_000 },
        { now: () => 0, sleep: async () => undefined },
      ),
    ).rejects.toBeInstanceOf(RunBudgetEnded);
  });

  it('gives up after the allowed number of waits', async () => {
    let n = 0;
    await expect(
      withRateLimit(
        async () => {
          n += 1;
          throw limited({ 'retry-after': '1' }, 429);
        },
        {},
        { now: () => 0, sleep: async () => undefined, maxWaits: 2 },
      ),
    ).rejects.toThrow('rate limited');
    expect(n).toBe(3);
  });

  it('passes other errors straight through', async () => {
    await expect(
      withRateLimit(async () => {
        throw new Error('boom');
      }, {}),
    ).rejects.toThrow('boom');
  });
});
