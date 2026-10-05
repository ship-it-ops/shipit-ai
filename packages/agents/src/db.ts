import { Pool, type PoolConfig } from 'pg';

export interface QueryResult<R> {
  rows: R[];
  rowCount: number | null;
}

export interface SqlClient {
  query<R extends object = Record<string, unknown>>(
    text: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<QueryResult<R>>;
}

export interface Db extends SqlClient {
  /** Runs `fn` in one transaction on one connection. Rolls back if `fn` throws. */
  tx<T>(fn: (client: SqlClient) => Promise<T>): Promise<T>;
  /** Runs `fn` on one dedicated connection, without opening a transaction. */
  withClient<T>(fn: (client: SqlClient) => Promise<T>): Promise<T>;
}

export interface CreatePoolOptions {
  connectionString: string;
  max?: number;
  /** Sets `search_path` for every connection. Used by tests to isolate a schema. */
  searchPath?: string;
  onError?: (err: Error) => void;
  /**
   * Server-side `statement_timeout` for every connection, in ms. Defaults to
   * 10 s so a stalled database fails a request instead of hanging it. 0 turns
   * it off: the migrator waits on an advisory lock and runs long DDL.
   */
  statementTimeoutMs?: number;
}

const DEFAULT_STATEMENT_TIMEOUT_MS = 10_000;
// Extra time for the client-side backstop, which fires only when the server
// stops answering altogether and its own statement_timeout cannot.
const QUERY_TIMEOUT_GRACE_MS = 5_000;

export function createPool(opts: CreatePoolOptions): Pool {
  const config: PoolConfig = {
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // A peer that vanished without closing (a node lost) is otherwise only
    // noticed when something is written to the connection.
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  };
  if (opts.searchPath) config.options = `-c search_path=${opts.searchPath}`;
  const statementTimeout = opts.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  if (statementTimeout > 0) {
    config.statement_timeout = statementTimeout;
    config.query_timeout = statementTimeout + QUERY_TIMEOUT_GRACE_MS;
  }
  const pool = new Pool(config);
  // An idle client that errors (server restart, network drop) emits 'error' on
  // the pool. With no listener Node treats it as an uncaught exception and the
  // process dies: the BullMQ error-listener scar in another costume.
  pool.on(
    'error',
    opts.onError ?? ((err) => console.error(`[agents] postgres pool error: ${err.message}`)),
  );
  return pool;
}

// The slice of pg's Pool and PoolClient this module uses. Both satisfy it.
interface PgQueryable {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

function wrap(target: PgQueryable): SqlClient {
  return {
    async query<R extends object>(text: string, params?: ReadonlyArray<unknown>) {
      const result = await target.query(text, params ? [...params] : undefined);
      return { rows: result.rows as R[], rowCount: result.rowCount };
    },
  };
}

// Whether a failed query leaves its connection unusable. An ordinary error
// from the server (a constraint, a syntax error, a cancelled statement) carries
// a five-character SQLSTATE and the session lives on. Two kinds do not: an
// error with no SQLSTATE came from below SQL (a reset socket, the client-side
// query timeout), and a FATAL one is the server ending the session (a restart,
// a failover, an idle timeout), which has an SQLSTATE all the same.
const SESSION_ENDED = /^(08...|57P0[1-5]|25P03)$/;
function connectionLost(err: unknown): boolean {
  const e = (err ?? {}) as { code?: unknown; severity?: unknown };
  if (typeof e.code !== 'string' || !/^[0-9A-Z]{5}$/.test(e.code)) return true;
  return e.severity === 'FATAL' || e.severity === 'PANIC' || SESSION_ENDED.test(e.code);
}

// The slice of pg's PoolClient a checked-out connection needs.
interface PgClient extends PgQueryable {
  on(event: 'error', listener: (err: Error) => void): unknown;
  removeListener(event: 'error', listener: (err: Error) => void): unknown;
  release(destroy?: boolean): void;
}

/**
 * One connection checked out of the pool, until `release()`.
 *
 * pg-pool takes its own 'error' listener off a client it hands out. A
 * connection the server ends or the network resets then emits 'error' with
 * nobody listening, which Node turns into an uncaught exception: the process
 * dies. The listener here is what keeps it alive; the query in flight, if
 * any, rejects by itself.
 *
 * A connection that failed is handed back to be destroyed. pg-pool keeps a
 * client unless it is released with a truthy argument, and a broken one would
 * fail the next caller the same way.
 */
function checkOut(client: PgClient): { sql: SqlClient; broken(): boolean; release(): void } {
  const inner = wrap(client);
  let broken = false;
  const onError = (): void => {
    broken = true;
  };
  client.on('error', onError);
  return {
    sql: {
      async query<R extends object>(text: string, params?: ReadonlyArray<unknown>) {
        try {
          return await inner.query<R>(text, params);
        } catch (err) {
          if (connectionLost(err)) broken = true;
          throw err;
        }
      },
    },
    broken: () => broken,
    release() {
      client.removeListener('error', onError);
      client.release(broken ? true : undefined);
    },
  };
}

export function createDb(pool: Pool): Db {
  const root = wrap(pool);
  return {
    query: (text, params) => root.query(text, params),
    async withClient(fn) {
      const held = checkOut(await pool.connect());
      try {
        return await fn(held.sql);
      } finally {
        held.release();
      }
    },
    async tx(fn) {
      const held = checkOut(await pool.connect());
      try {
        await held.sql.query('BEGIN');
        const value = await fn(held.sql);
        await held.sql.query('COMMIT');
        return value;
      } catch (err) {
        // Destroying a broken connection ends its transaction; a ROLLBACK on
        // it would only wait for the query timeout a second time.
        if (!held.broken()) await held.sql.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        held.release();
      }
    },
  };
}
