import { describe, it, expect } from 'vitest';
import { createDb, createPool } from '../db.js';
import { DATABASE_TEST_URL } from './test-db.js';

describe.skipIf(!DATABASE_TEST_URL)('createPool — Postgres integration', () => {
  it('cancels a statement that runs past the statement timeout', async () => {
    const pool = createPool({
      connectionString: DATABASE_TEST_URL!,
      max: 1,
      statementTimeoutMs: 200,
    });
    try {
      await expect(createDb(pool).query('SELECT pg_sleep(2)')).rejects.toMatchObject({
        code: '57014', // query_canceled
      });
      // The connection is still usable afterwards.
      const ok = await createDb(pool).query<{ one: number }>('SELECT 1 AS one');
      expect(ok.rows[0]?.one).toBe(1);
    } finally {
      await pool.end();
    }
  });

  // Checked out of the pool, a pg client has no 'error' listener of its own. A
  // session the server ends (a restart, a failover) then emits 'error' with
  // nobody listening, and Node ends the process. These run the real driver:
  // one test per moment the session can end.
  describe('a session the server ends while a caller holds the connection', () => {
    const run = async (
      use: 'tx' | 'withClient',
      moment: 'during a query' | 'between two queries',
    ): Promise<{ outcome: string; uncaught: Error[]; next: unknown }> => {
      const pool = createPool({ connectionString: DATABASE_TEST_URL!, max: 2, onError: () => {} });
      const admin = createPool({ connectionString: DATABASE_TEST_URL!, max: 1 });
      const db = createDb(pool);
      const uncaught: Error[] = [];
      const onUncaught = (err: Error): void => void uncaught.push(err);
      process.on('uncaughtException', onUncaught);
      try {
        const work = async (client: Parameters<Parameters<typeof db.tx>[0]>[0]): Promise<void> => {
          const { rows } = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          const end = (): Promise<unknown> =>
            admin.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);
          if (moment === 'between two queries') {
            await end();
            await new Promise((resolve) => setTimeout(resolve, 200));
            await client.query('SELECT 1');
            return;
          }
          setTimeout(() => void end(), 100);
          await client.query('SELECT pg_sleep(5)');
        };
        const outcome = await (use === 'tx' ? db.tx(work) : db.withClient(work)).then(
          () => 'resolved',
          () => 'rejected',
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        const next = await db.query<{ ok: number }>('SELECT 1 AS ok').then(
          (result) => result.rows[0],
          (err: Error) => err.message,
        );
        return { outcome, uncaught, next };
      } finally {
        process.off('uncaughtException', onUncaught);
        await pool.end();
        await admin.end();
      }
    };

    it.each([
      ['tx', 'during a query'],
      ['tx', 'between two queries'],
      ['withClient', 'during a query'],
      ['withClient', 'between two queries'],
    ] as const)(
      '%s, %s: the caller is refused, the process lives, the pool recovers',
      async (use, moment) => {
        expect(await run(use, moment)).toEqual({
          outcome: 'rejected',
          uncaught: [],
          next: { ok: 1 },
        });
      },
    );
  });
});
