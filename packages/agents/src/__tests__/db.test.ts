import { describe, it, expect, vi } from 'vitest';
import { createPool } from '../db.js';

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
});
