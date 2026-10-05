import { describe, it, expect, vi } from 'vitest';
import type { Pool } from 'pg';
import { createDb, createPool } from '../db.js';

// No connection is opened here: pg connects lazily, on the first query.
const URL = 'postgres://user:pw@127.0.0.1:1/none';

describe('createPool', () => {
  it('survives an idle-client error instead of crashing the process', async () => {
    const onError = vi.fn();
    const pool = createPool({ connectionString: URL, onError });
    expect(pool.listenerCount('error')).toBe(1);
    // With no listener, emitting 'error' on an EventEmitter throws.
    expect(() => pool.emit('error', new Error('server closed the connection'))).not.toThrow();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'server closed the connection' }),
    );
    await pool.end();
  });

  it('logs by default when no handler is given', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const pool = createPool({ connectionString: URL });
    pool.emit('error', new Error('boom'));
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('boom'));
    spy.mockRestore();
    await pool.end();
  });

  it('applies the pool size and search path it is given', async () => {
    const pool = createPool({ connectionString: URL, max: 3, searchPath: 'itest_abc' });
    expect(pool.options.max).toBe(3);
    expect(pool.options.options).toBe('-c search_path=itest_abc');
    await pool.end();
  });

  it('bounds every statement by default, so a stalled server cannot hang a request', async () => {
    const pool = createPool({ connectionString: URL });
    expect(pool.options.statement_timeout).toBe(10_000);
    // The client-side backstop fires only if the server stops answering at all.
    expect(pool.options.query_timeout).toBe(15_000);
    await pool.end();
  });

  it('takes a custom statement timeout, and 0 turns both timeouts off', async () => {
    const custom = createPool({ connectionString: URL, statementTimeoutMs: 2_000 });
    expect(custom.options.statement_timeout).toBe(2_000);
    expect(custom.options.query_timeout).toBe(7_000);
    await custom.end();
    const off = createPool({ connectionString: URL, statementTimeoutMs: 0 });
    expect(off.options.statement_timeout).toBeUndefined();
    expect(off.options.query_timeout).toBeUndefined();
    await off.end();
  });

  // Without keepalive a connection whose peer vanished (a node lost, not a
  // clean close) looks healthy until something is written to it.
  it('turns TCP keepalive on', async () => {
    const pool = createPool({ connectionString: URL });
    expect(pool.options.keepAlive).toBe(true);
    expect(pool.options.keepAliveInitialDelayMillis).toBe(10_000);
    await pool.end();
  });
});

// A stand-in for pg's Pool: one client whose queries are scripted, recording
// what was sent and how the client was handed back.
function fakePool(answer: (text: string) => Promise<unknown>) {
  const sent: string[] = [];
  const release = vi.fn();
  const listeners = new Set<(err: Error) => void>();
  const client = {
    query: async (text: string) => {
      sent.push(text);
      return (await answer(text)) ?? { rows: [], rowCount: 0 };
    },
    on: (_event: 'error', listener: (err: Error) => void) => void listeners.add(listener),
    removeListener: (_event: 'error', listener: (err: Error) => void) =>
      void listeners.delete(listener),
    release,
  };
  const pool = { connect: async () => client, query: client.query } as unknown as Pool;
  /** What pg does when the server or the network ends the connection. */
  const emitError = (err: Error): void => {
    for (const listener of listeners) listener(err);
  };
  return { pool, sent, release, listeners, emitError };
}

const serverError = () => Object.assign(new Error('duplicate key value'), { code: '23505' });
const socketError = () => Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });

describe('createDb', () => {
  it('commits a transaction and hands the connection back', async () => {
    const { pool, sent, release } = fakePool(async () => undefined);
    await createDb(pool).tx((client) => client.query('SELECT 1'));
    expect(sent).toEqual(['BEGIN', 'SELECT 1', 'COMMIT']);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]![0]).toBeFalsy();
  });

  it('rolls back and keeps the connection when the server refuses a statement', async () => {
    const { pool, sent, release } = fakePool(async (text) => {
      if (text === 'INSERT') throw serverError();
      return undefined;
    });
    await expect(createDb(pool).tx((client) => client.query('INSERT'))).rejects.toThrow(
      'duplicate key value',
    );
    expect(sent).toEqual(['BEGIN', 'INSERT', 'ROLLBACK']);
    expect(release.mock.calls[0]![0]).toBeFalsy();
  });

  it('rolls back and keeps the connection when the callback itself throws', async () => {
    const { pool, sent, release } = fakePool(async () => undefined);
    await expect(
      createDb(pool).tx(async () => {
        throw new Error('not waiting for input');
      }),
    ).rejects.toThrow('not waiting for input');
    expect(sent).toEqual(['BEGIN', 'ROLLBACK']);
    expect(release.mock.calls[0]![0]).toBeFalsy();
  });

  // pg-pool keeps a client unless it is released with an error. A connection
  // that failed below SQL (reset, or the client-side query timeout) would go
  // back into the pool and fail the next caller the same way.
  it('discards a connection that failed below SQL, without trying to roll back on it', async () => {
    const { pool, sent, release } = fakePool(async (text) => {
      if (text === 'SELECT 1') throw socketError();
      return undefined;
    });
    await expect(createDb(pool).tx((client) => client.query('SELECT 1'))).rejects.toThrow(
      'ECONNRESET',
    );
    expect(sent).toEqual(['BEGIN', 'SELECT 1']);
    expect(release).toHaveBeenCalledWith(true);
  });

  it('discards a connection whose query timed out on the client side', async () => {
    const { pool, release } = fakePool(async (text) => {
      if (text === 'SELECT pg_sleep(60)') throw new Error('Query read timeout');
      return undefined;
    });
    await expect(
      createDb(pool).withClient((client) => client.query('SELECT pg_sleep(60)')),
    ).rejects.toThrow('Query read timeout');
    expect(release).toHaveBeenCalledWith(true);
  });

  // The server ending a session (a restart, a failover) is reported with an
  // SQLSTATE too, but the connection is gone.
  it.each([
    ['57P01', 'terminating connection due to administrator command'],
    ['57P02', 'terminating connection due to crash of another server process'],
    ['08006', 'connection failure'],
    ['25P03', 'terminating connection due to idle-in-transaction timeout'],
  ])(
    'discards a connection the server ended (%s), without rolling back on it',
    async (code, message) => {
      const { pool, sent, release } = fakePool(async (text) => {
        if (text === 'SELECT 1')
          throw Object.assign(new Error(message), { code, severity: 'FATAL' });
        return undefined;
      });
      await expect(createDb(pool).tx((client) => client.query('SELECT 1'))).rejects.toThrow(
        message,
      );
      expect(sent).toEqual(['BEGIN', 'SELECT 1']);
      expect(release).toHaveBeenCalledWith(true);
    },
  );

  // The driver reports the severity in the server's own language
  // (`lc_messages`), so the SQLSTATE is what tells a session that ended...
  it('goes by the SQLSTATE when the severity is not in English', async () => {
    const { pool, sent, release } = fakePool(async (text) => {
      if (text === 'SELECT 1') {
        throw Object.assign(new Error('завершение подключения по команде администратора'), {
          code: '57P01',
          severity: 'ВАЖНО',
        });
      }
      return undefined;
    });
    await expect(createDb(pool).tx((client) => client.query('SELECT 1'))).rejects.toThrow();
    expect(sent).toEqual(['BEGIN', 'SELECT 1']);
    expect(release).toHaveBeenCalledWith(true);
  });

  // ...and FATAL, where it can be read, covers the codes not listed.
  it('discards a connection on a FATAL error whatever its SQLSTATE', async () => {
    const { pool, sent, release } = fakePool(async (text) => {
      if (text === 'SELECT 1') {
        throw Object.assign(new Error('out of memory'), { code: '53200', severity: 'FATAL' });
      }
      return undefined;
    });
    await expect(createDb(pool).tx((client) => client.query('SELECT 1'))).rejects.toThrow();
    expect(sent).toEqual(['BEGIN', 'SELECT 1']);
    expect(release).toHaveBeenCalledWith(true);
  });

  // 08P01 is in the class of connection errors, but the server raises it as an
  // ordinary error (a bind with the wrong number of parameters) and the
  // session goes on: the transaction is rolled back and the connection kept.
  it('keeps the connection after a protocol violation the session survives', async () => {
    const { pool, sent, release } = fakePool(async (text) => {
      if (text === 'SELECT $1') {
        throw Object.assign(
          new Error('bind message supplies 0 parameters, but prepared statement "" requires 1'),
          { code: '08P01', severity: 'ERROR' },
        );
      }
      return undefined;
    });
    await expect(createDb(pool).tx((client) => client.query('SELECT $1'))).rejects.toThrow(
      /bind message/,
    );
    expect(sent).toEqual(['BEGIN', 'SELECT $1', 'ROLLBACK']);
    expect(release.mock.calls[0]![0]).toBeFalsy();
  });

  // pg-pool takes its own 'error' listener off a client it hands out. With
  // none, a connection that drops emits 'error' into nothing and Node ends the
  // process. Ours is there for exactly as long as the connection is held.
  it('listens for connection errors while it holds a connection, and no longer', async () => {
    const { pool, listeners } = fakePool(async () => undefined);
    const during: number[] = [];
    await createDb(pool).tx(async () => void during.push(listeners.size));
    await createDb(pool).withClient(async () => void during.push(listeners.size));
    expect(during).toEqual([1, 1]);
    expect(listeners.size).toBe(0);
  });

  it('discards a connection that dropped while it was held, even when no query failed', async () => {
    const { pool, release, emitError } = fakePool(async () => undefined);
    await createDb(pool).withClient(async () => {
      expect(() => emitError(new Error('read ECONNRESET'))).not.toThrow();
    });
    expect(release).toHaveBeenCalledWith(true);
  });

  it('keeps a dedicated connection after a server error', async () => {
    const { pool, release } = fakePool(async () => {
      throw serverError();
    });
    await expect(createDb(pool).withClient((client) => client.query('INSERT'))).rejects.toThrow();
    expect(release.mock.calls[0]![0]).toBeFalsy();
  });
});
