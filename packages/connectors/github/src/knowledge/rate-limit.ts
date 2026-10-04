// Spec §Sources: every call honours Retry-After; a rate limit pauses the job,
// it does not fail the run; a wait that outlives the run's budget ends the run.
import { KnowledgeRunCutShort } from '@shipit-ai/connector-sdk';

export const NOTE_RATE_LIMITED = 'rate_limited';

/**
 * The wait GitHub asked for does not fit in what is left of the run. It is the
 * SDK's "run cut short" signal: the harness ends the run with the note and
 * records no failure; the next run resumes from the checkpoints.
 */
export class RunBudgetEnded extends KnowledgeRunCutShort {
  constructor(waitMs: number) {
    super(
      NOTE_RATE_LIMITED,
      `GitHub asked to wait ${Math.ceil(waitMs / 1000)} s, past the end of this run`,
    );
    this.name = 'RunBudgetEnded';
  }
}

type Headers = Record<string, string | number | undefined>;

// The two shapes Octokit throws. REST (RequestError): `status` and the HTTP
// response's headers. GraphQL (GraphqlResponseError): GitHub answers a spent
// budget with HTTP 200 and an error in the body, so there is NO `status`; the
// errors are on `errors` and the headers on `headers` (its `response` is the
// body, not an HTTP response). Checked against @octokit/graphql 9.0.3.
interface RateLimitedError {
  status?: number;
  message?: string;
  response?: { headers?: Headers };
  headers?: Headers;
  errors?: Array<{ type?: string } | null>;
}

const MINUTE_MS = 60_000;

/** Milliseconds to wait when `err` is a rate-limit answer; null when it is something else. */
export function rateLimitWaitMs(err: unknown, now: number): number | null {
  const e = (err ?? {}) as RateLimitedError;
  const graphqlLimited =
    Array.isArray(e.errors) && e.errors.some((x) => x?.type === 'RATE_LIMITED');
  if (!graphqlLimited && e.status !== 403 && e.status !== 429) return null;
  const headers = e.response?.headers ?? e.headers ?? {};
  const retryAfter = Number(headers['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return retryAfter * 1000;
  if (String(headers['x-ratelimit-remaining']) === '0') {
    const reset = Number(headers['x-ratelimit-reset']);
    if (Number.isFinite(reset)) return Math.max(0, reset * 1000 - now) + 1000;
  }
  // A limit with no hint about when it ends: GitHub asks for at least a minute.
  if (graphqlLimited || e.status === 429) return MINUTE_MS;
  return /secondary rate limit/i.test(e.message ?? '') ? MINUTE_MS : null;
}

/**
 * What a connector instance remembers about the limit it ran into, so its next
 * call (the next repository of the same run) does not spend a request, and
 * lengthen a secondary limit, to learn the same thing again.
 */
export interface RateLimitState {
  /** Epoch milliseconds until which GitHub asked this installation to wait. */
  limitedUntil: number;
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
    state?: RateLimitState;
  } = {},
): Promise<T> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const maxWaits = deps.maxWaits ?? 3;
  const state = deps.state;
  const wait = async (waitMs: number): Promise<void> => {
    if (limits.deadline !== undefined && now() + waitMs > limits.deadline) {
      throw new RunBudgetEnded(waitMs);
    }
    await sleep(waitMs, limits.signal);
  };

  // A limit an earlier call ran into is still in force: wait it out, or end
  // the run, before spending a request.
  if (state && state.limitedUntil > now()) await wait(state.limitedUntil - now());

  for (let waits = 0; ; waits++) {
    try {
      return await fn();
    } catch (err) {
      const waitMs = rateLimitWaitMs(err, now());
      if (waitMs === null || waits >= maxWaits) throw err;
      if (state) state.limitedUntil = Math.max(state.limitedUntil, now() + waitMs);
      await wait(waitMs);
    }
  }
}
