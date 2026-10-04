// packages/connectors/github/src/knowledge/rate-limit.ts
// Spec §Sources: every call honours Retry-After; a rate limit pauses the job,
// it does not fail the run; a wait that outlives the run's budget ends the run.

/** The wait GitHub asked for does not fit in what is left of the run. */
export class RunBudgetEnded extends Error {
  constructor(waitMs: number) {
    super(`GitHub asked to wait ${Math.ceil(waitMs / 1000)} s, past the end of this run`);
    this.name = 'RunBudgetEnded';
  }
}

interface HttpError {
  status?: number;
  response?: { headers?: Record<string, string | number | undefined> };
}

/** Milliseconds to wait when `err` is a rate-limit answer; null when it is something else. */
export function rateLimitWaitMs(err: unknown, now: number): number | null {
  const e = (err ?? {}) as HttpError;
  if (e.status !== 403 && e.status !== 429) return null;
  const headers = e.response?.headers ?? {};
  const retryAfter = Number(headers['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  if (String(headers['x-ratelimit-remaining']) === '0') {
    const reset = Number(headers['x-ratelimit-reset']);
    if (Number.isFinite(reset)) return Math.max(0, reset * 1000 - now) + 1000;
  }
  // A 429 with no hint: back off a minute.
  return e.status === 429 ? 60_000 : null;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('aborted'));
      },
      { once: true },
    );
  });
}

export async function withRateLimit<T>(
  fn: () => Promise<T>,
  limits: { signal?: AbortSignal; deadline?: number },
  deps: {
    now?: () => number;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    maxWaits?: number;
  } = {},
): Promise<T> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const maxWaits = deps.maxWaits ?? 3;
  for (let waits = 0; ; waits++) {
    try {
      return await fn();
    } catch (err) {
      const waitMs = rateLimitWaitMs(err, now());
      if (waitMs === null || waits >= maxWaits) throw err;
      if (limits.deadline !== undefined && now() + waitMs > limits.deadline) {
        throw new RunBudgetEnded(waitMs);
      }
      await sleep(waitMs, limits.signal);
    }
  }
}
