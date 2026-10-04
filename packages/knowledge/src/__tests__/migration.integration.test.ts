import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes } from 'node:crypto';
import { createDb, createPool, runMigrations } from '@shipit-ai/agents';
import {
  DATABASE_TEST_URL,
  MIGRATIONS_DIR,
  createMigratedTestDatabase,
  type TestDatabase,
} from './test-db.js';
import { missingKnowledgeMigrations } from '../status.js';
import { hasVectorExtension } from '../bootstrap.js';

describe.skipIf(!DATABASE_TEST_URL)('0002_knowledge on a real pgvector Postgres', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createMigratedTestDatabase();
  });
  afterAll(async () => {
    await database?.drop();
  });

  it('applies and leaves nothing missing', async () => {
    expect(await hasVectorExtension(database.db)).toBe(true);
    expect(await missingKnowledgeMigrations(database.db)).toEqual([]);
  });

  it('creates the embedding column as halfvec(768) with an hnsw index', async () => {
    const { rows } = await database.db.query<{ format_type: string }>(
      `SELECT format_type(a.atttypid, a.atttypmod)
         FROM pg_attribute a
         JOIN pg_class c ON c.oid = a.attrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = 'knowledge_chunks' AND a.attname = 'embedding'`,
      [database.schema],
    );
    expect(rows[0]?.format_type).toBe('halfvec(768)');

    const idx = await database.db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = 'knowledge_chunks_embedding_idx'`,
      [database.schema],
    );
    expect(idx.rows[0]?.indexdef).toContain('USING hnsw');
  });

  it('resolves the cosine operator from the private schema', async () => {
    const { rows } = await database.db.query<{ distance: number }>(
      `SELECT '[1,0,0]'::halfvec(3) <=> '[0,1,0]'::halfvec(3) AS distance`,
    );
    expect(Number(rows[0]!.distance)).toBeCloseTo(1, 5);
  });

  it('rejects an unknown container kind', async () => {
    await expect(
      database.db.query(
        `INSERT INTO knowledge_containers (id, connector_id, external_id, kind, name)
         VALUES (gen_random_uuid(), 'c1', 'x', 'bucket', 'x')`,
      ),
    ).rejects.toThrow(/knowledge_containers_kind/);
  });
});

// The extension is per database, so the only way to meet a database without it
// is to create one. The CI and compose `shipit` user may; the suite's shared
// database is left as it is.
describe.skipIf(!DATABASE_TEST_URL)('0002_knowledge without pgvector', () => {
  it('fails with a readable message when the vector extension is missing', async () => {
    const name = `ktest_noext_${randomBytes(6).toString('hex')}`;
    const admin = createPool({ connectionString: DATABASE_TEST_URL!, max: 1 });
    await admin.query(`CREATE DATABASE ${name}`);
    const url = new URL(DATABASE_TEST_URL!);
    url.pathname = `/${name}`;
    const pool = createPool({ connectionString: url.toString(), max: 2 });
    try {
      await expect(runMigrations({ db: createDb(pool), dir: MIGRATIONS_DIR })).rejects.toThrow(
        /"vector" extension \(pgvector\) is not installed/,
      );
      const { rows } = await pool.query(`SELECT to_regclass('knowledge_documents') AS t`);
      expect(rows[0].t).toBeNull();
    } finally {
      await pool.end();
      await admin.query(`DROP DATABASE ${name}`);
      await admin.end();
    }
  });
});
