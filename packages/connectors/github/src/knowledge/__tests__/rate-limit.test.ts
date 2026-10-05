import { describe, it, expect } from 'vitest';
import { isRunCutShort } from '@shipit-ai/connector-sdk';
import { RunBudgetEnded, rateLimitWaitMs, withRateLimit } from '../rate-limit.js';

const limited = (headers: Record<string, string>, status = 403) =>
  Object.assign(new Error('rate limited'), { status, response: { headers } });

// What octokit.graphql throws when the installation's GraphQL budget is spent.
// GitHub answers HTTP 200 with an error in the body, so the error
// (@octokit/graphql's GraphqlResponseError) has NO `status`, and the rate-limit
// headers sit on `err.headers`, not on `err.response.headers`. Shape checked
// against @octokit/graphql 9.0.3.
const graphqlError = (type: string, headers: Record<string, string> = {}) =>
  Object.assign(new Error('API rate limit exceeded for installation ID 1.'), {
    name: 'GraphqlResponseError',
    errors: [{ type, message: 'API rate limit exceeded for installation ID 1.' }],
    headers,
    data: { repository: null },
  });

describe('rateLimitWaitMs', () => {
  it('recognises a spent GraphQL budget: HTTP 200 with a RATE_LIMITED error', () => {
    const err = graphqlError('RATE_LIMITED', {
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': '1000',
    });
    expect(rateLimitWaitMs(err, 990_000)).toBe(11_000); // to the reset, plus a second
  });

  it('waits a minute when a GraphQL rate limit says nothing about when it ends', () => {
    expect(rateLimitWaitMs(graphqlError('RATE_LIMITED'), 0)).toBe(60_000);
  });

  it('waits a minute on a secondary limit that names itself and gives no header', () => {
    const err = Object.assign(new Error('You have exceeded a secondary rate limit.'), {
      status: 403,
      response: { headers: {} },
    });
    expect(rateLimitWaitMs(err, 0)).toBe(60_000);
  });

  it('is null for a GraphQL error that is not a rate limit', () => {
    expect(rateLimitWaitMs(graphqlError('NOT_FOUND'), 0)).toBeNull();
  });

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

  it('is the SDK signal that ends a run without failing it, with the note for the run record', () => {
    const err = new RunBudgetEnded(600_000);
    expect(isRunCutShort(err)).toBe(true);
    expect(err.note).toBe('rate_limited');
  });

  it('does not call GitHub again while a limit that outlives the run is in force', async () => {
    // One state per connector instance: the second container of a run must not
    // spend a call (and extend a secondary limit) to learn what the first did.
    const state = { limitedUntil: 0 };
    let calls = 0;
    const fn = async (): Promise<never> => {
      calls += 1;
      throw limited({ 'retry-after': '600' }, 429);
    };
    const deps = { sleep: async () => undefined, state };
    await expect(
      withRateLimit(fn, { deadline: 60_000 }, { ...deps, now: () => 0 }),
    ).rejects.toBeInstanceOf(RunBudgetEnded);
    await expect(
      withRateLimit(fn, { deadline: 60_000 }, { ...deps, now: () => 5_000 }),
    ).rejects.toBeInstanceOf(RunBudgetEnded);
    expect(calls).toBe(1);
  });

  it('waits out a remembered limit that fits in the run, then calls', async () => {
    const state = { limitedUntil: 3_000 };
    const slept: number[] = [];
    const out = await withRateLimit(
      async () => 'ok',
      { deadline: 60_000 },
      { now: () => 1_000, sleep: async (ms) => void slept.push(ms), state },
    );
    expect(out).toBe('ok');
    expect(slept).toEqual([2_000]);
  });

  // A run or a refresh that was stopped while the request was in flight: the
  // wait GitHub then asks for must not be sat out. An abort listener added
  // afterwards never fires, so the sleep has to look before it starts.
  it('does not sit out a wait when it has already been stopped', { timeout: 2_000 }, async () => {
    const stop = new AbortController();
    let calls = 0;
    const started = Date.now();
    await expect(
      withRateLimit(
        async () => {
          calls += 1;
          stop.abort();
          throw limited({ 'retry-after': '30' }, 429);
        },
        { signal: stop.signal },
      ),
    ).rejects.toThrow(/aborted/);
    expect(calls).toBe(1);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('ends a wait in progress when it is stopped', async () => {
    const stop = new AbortController();
    const waiting = withRateLimit(
      async () => {
        throw limited({ 'retry-after': '30' }, 429);
      },
      { signal: stop.signal },
    );
    setTimeout(() => stop.abort(), 10);
    await expect(waiting).rejects.toThrow(/aborted/);
  });

  it('passes other errors straight through', async () => {
    await expect(
      withRateLimit(async () => {
        throw new Error('boom');
      }, {}),
    ).rejects.toThrow('boom');
  });
});
