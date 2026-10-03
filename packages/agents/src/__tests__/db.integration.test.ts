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
});
