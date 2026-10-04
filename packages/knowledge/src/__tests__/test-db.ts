// Harness for the Postgres-backed knowledge suites. Like packages/agents'
// harness it gives each suite a private schema, with two additions: the
// pgvector extension is created first (the CI and compose `shipit` user is the
// container's superuser), and `public` stays on the search_path so the
// extension's types and operators (`halfvec`, `<=>`) resolve from the private
// schema. Suites still run serially (--no-file-parallelism): migrations take
// one database-wide advisory lock.
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, createPool, runMigrations, type Db } from '@shipit-ai/agents';
import { ensureVectorExtension } from '../bootstrap.js';

const here = dirname(fileURLToPath(import.meta.url));

/** Set in CI and when Postgres is running locally. Unset: the suites skip. */
export const DATABASE_TEST_URL: string | undefined = process.env.DATABASE_TEST_URL;

/** <repo root>/db/migrations */
export const MIGRATIONS_DIR = resolve(here, '../../../../db/migrations');

export interface TestDatabase {
  db: Db;
  schema: string;
  drop(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  if (!DATABASE_TEST_URL) throw new Error('DATABASE_TEST_URL is not set');
  const schema = `ktest_${randomBytes(6).toString('hex')}`;

  const admin = createPool({ connectionString: DATABASE_TEST_URL, max: 1 });
  try {
    await ensureVectorExtension(createDb(admin));
    await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }

  const pool = createPool({
    connectionString: DATABASE_TEST_URL,
    max: 4,
    searchPath: `${schema},public`,
    // HNSW index creation and the first embeddings insert can exceed the
    // 10 s default on a cold CI runner.
    statementTimeoutMs: 60_000,
  });
  return {
    db: createDb(pool),
    schema,
    async drop() {
      try {
        await pool.query(`DROP SCHEMA ${schema} CASCADE`);
      } finally {
        await pool.end();
      }
    },
  };
}

/** A private schema with every file in db/migrations/ applied. */
export async function createMigratedTestDatabase(): Promise<TestDatabase> {
  const database = await createTestDatabase();
  try {
    await runMigrations({ db: database.db, dir: MIGRATIONS_DIR });
  } catch (err) {
    await database.drop();
    throw err;
  }
  return database;
}
