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

// An error the server sent carries a five-character SQLSTATE and leaves the
// connection usable. Anything else a query fails with (a reset socket, the
// client-side query timeout) means the connection cannot be trusted again.
function failedBelowSql(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return !(typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code));
}

/** One checked-out connection, remembering whether a query on it failed below SQL. */
function dedicated(client: PgQueryable): { sql: SqlClient; broken: () => boolean } {
  const inner = wrap(client);
  let broken = false;
  return {
    sql: {
      async query<R extends object>(text: string, params?: ReadonlyArray<unknown>) {
        try {
          return await inner.query<R>(text, params);
        } catch (err) {
          if (failedBelowSql(err)) broken = true;
          throw err;
        }
      },
    },
    broken: () => broken,
  };
}

export function createDb(pool: Pool): Db {
  const root = wrap(pool);
  return {
    query: (text, params) => root.query(text, params),
    async withClient(fn) {
      const client = await pool.connect();
      const scoped = dedicated(client);
      try {
        return await fn(scoped.sql);
      } finally {
        // pg-pool keeps a client unless it is released with an error: a broken
        // one would be handed to the next caller.
        client.release(scoped.broken() ? true : undefined);
      }
    },
    async tx(fn) {
      const client = await pool.connect();
      const scoped = dedicated(client);
      try {
        await scoped.sql.query('BEGIN');
        const value = await fn(scoped.sql);
        await scoped.sql.query('COMMIT');
        return value;
      } catch (err) {
        // Dropping a broken connection ends its transaction; a ROLLBACK on it
        // would only wait for the query timeout a second time.
        if (!scoped.broken()) await scoped.sql.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release(scoped.broken() ? true : undefined);
      }
    },
  };
}
