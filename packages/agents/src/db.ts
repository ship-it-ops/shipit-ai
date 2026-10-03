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
}

export function createPool(opts: CreatePoolOptions): Pool {
  const config: PoolConfig = {
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  };
  if (opts.searchPath) config.options = `-c search_path=${opts.searchPath}`;
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

export function createDb(pool: Pool): Db {
  const root = wrap(pool);
  return {
    query: (text, params) => root.query(text, params),
    async withClient(fn) {
      const client = await pool.connect();
      try {
        return await fn(wrap(client));
      } finally {
        client.release();
      }
    },
    async tx(fn) {
      const client = await pool.connect();
      const scoped = wrap(client);
      try {
        await scoped.query('BEGIN');
        const value = await fn(scoped);
        await scoped.query('COMMIT');
        return value;
      } catch (err) {
        await scoped.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },
  };
}
