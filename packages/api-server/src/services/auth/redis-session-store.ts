import type { Redis } from 'ioredis';
import type { SessionStore } from '@fastify/session';
import type { Session } from 'fastify';

// Adapter that lets `@fastify/session` persist sessions in Redis. The
// plugin's SessionStore interface is callback-based; ioredis is
// promise-based; this module bridges the two. Single-tenant deployments
// can share the existing connector-run-store Redis instance — sessions
// land under their own key prefix so the namespaces don't collide.
//
// Sessions are stored as JSON. The TTL the store sets matches the
// session's cookie maxAge so an evicted Redis key surfaces as a logged-out
// user, not a logged-in user with a stale cookie.

export interface RedisSessionStoreOptions {
  /** Redis client. Reused from the api-server's existing ioredis instance. */
  redis: Redis;
  /** Key namespace. Defaults to `shipit:session:`. */
  prefix?: string;
  /** Fallback TTL (seconds) when the session has no cookie maxAge set. */
  defaultTtlSeconds?: number;
}

const DEFAULT_PREFIX = 'shipit:session:';
const DEFAULT_TTL_SECONDS = 12 * 60 * 60; // 12 hours — matches default cookie maxAge.

export class RedisSessionStore implements SessionStore {
  private readonly redis: Redis;
  private readonly prefix: string;
  private readonly defaultTtl: number;

  constructor(opts: RedisSessionStoreOptions) {
    this.redis = opts.redis;
    this.prefix = opts.prefix ?? DEFAULT_PREFIX;
    this.defaultTtl = opts.defaultTtlSeconds ?? DEFAULT_TTL_SECONDS;
  }

  private key(sessionId: string): string {
    return `${this.prefix}${sessionId}`;
  }

  private resolveTtlSeconds(session: Session): number {
    const cookie = session.cookie as { maxAge?: number; expires?: Date | null } | undefined;
    const maxAge = cookie?.maxAge;
    if (typeof maxAge === 'number' && maxAge > 0) {
      return Math.ceil(maxAge / 1000);
    }
    return this.defaultTtl;
  }

  set(sessionId: string, session: Session, callback: (err?: unknown) => void): void {
    const ttlSeconds = this.resolveTtlSeconds(session);
    const payload = JSON.stringify(session);
    this.redis.set(this.key(sessionId), payload, 'EX', ttlSeconds).then(
      () => callback(),
      (err: unknown) => callback(err),
    );
  }

  get(sessionId: string, callback: (err: unknown, result?: Session | null) => void): void {
    this.redis.get(this.key(sessionId)).then(
      (value) => {
        if (value === null) {
          callback(null, null);
          return;
        }
        try {
          const parsed = JSON.parse(value) as Session;
          callback(null, parsed);
        } catch (err) {
          // Corrupted payload — surface as "no session" so the caller
          // re-authenticates instead of crashing the request.
          callback(null, null);
          void err;
        }
      },
      (err: unknown) => callback(err),
    );
  }

  destroy(sessionId: string, callback: (err?: unknown) => void): void {
    this.redis.del(this.key(sessionId)).then(
      () => callback(),
      (err: unknown) => callback(err),
    );
  }
}
