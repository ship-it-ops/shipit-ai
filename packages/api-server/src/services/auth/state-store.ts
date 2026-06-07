import type { Redis } from 'ioredis';

// Short-lived storage for OAuth/OIDC state + PKCE verifier during a single
// login round-trip. The user starts login at /api/auth/login/:provider —
// we mint a `state` value and a `code_verifier`, store both keyed by
// state in Redis, and redirect the browser to the IdP. The IdP echoes
// `state` back via /api/auth/callback/:provider; we look it up to recover
// the verifier and validate against CSRF.
//
// 5-minute TTL is the cliff at which the IdP's authorization code itself
// expires; a longer window would just keep dead state alive in Redis.

const STATE_PREFIX = 'shipit:auth-state:';
const STATE_TTL_SECONDS = 5 * 60;

export interface AuthStateRecord {
  provider: 'oidc' | 'github';
  codeVerifier: string;
  redirectTo?: string;
  /** When the state was minted — for observability/logging only. */
  createdAt: string;
}

export class AuthStateStore {
  private readonly redis: Redis;

  constructor(redis: Redis) {
    this.redis = redis;
  }

  private key(state: string): string {
    return `${STATE_PREFIX}${state}`;
  }

  async put(state: string, record: AuthStateRecord): Promise<void> {
    await this.redis.set(this.key(state), JSON.stringify(record), 'EX', STATE_TTL_SECONDS);
  }

  /**
   * Look up state and delete it in one round-trip. State is single-use;
   * returning AND deleting atomically defends against replay even if the
   * caller forgets to drop it.
   */
  async consume(state: string): Promise<AuthStateRecord | null> {
    const key = this.key(state);
    const value = await this.redis.getdel(key);
    if (!value) return null;
    try {
      return JSON.parse(value) as AuthStateRecord;
    } catch {
      return null;
    }
  }
}
