// Shared harness for the Postgres-backed suites. Each call creates a private
// schema and a pool whose search_path points at it, so suites cannot see each
// other's tables. The suites still run with --no-file-parallelism (see the scar
// integration-tests-sharing-a-db-must-run-serially): migrations take one
// database-wide advisory lock.
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, createPool, type Db } from '../db.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Set in CI and when Postgres is running locally. Unset: the suites skip. */
export const DATABASE_TEST_URL: string | undefined = process.env.DATABASE_TEST_URL;

/** <repo root>/db/migrations */
export const MIGRATIONS_DIR = resolve(here, '../../../../db/migrations');

export interface TestDatabase {
  db: Db;
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  if (!DATABASE_TEST_URL) throw new Error('DATABASE_TEST_URL is not set');
  const schema = `itest_${randomBytes(6).toString('hex')}`;

  const admin = createPool({ connectionString: DATABASE_TEST_URL, max: 1 });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }

  // `public` stays on the search_path: db/migrations/ includes the knowledge
  // layer's tables, whose halfvec columns and operators come from the pgvector
  // extension installed in `public` (created by `pnpm db:bootstrap`).
  const pool = createPool({
    connectionString: DATABASE_TEST_URL,
    max: 4,
    searchPath: `${schema},public`,
  });
  return {
    db: createDb(pool),
    async drop() {
      try {
        await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await pool.end();
      }
    },
  };
}
