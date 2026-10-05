import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../migrate.js';
import { EXPECTED_SCHEMA_VERSION } from '../schema-version.js';
import {
  createTestDatabase,
  DATABASE_TEST_URL,
  MIGRATIONS_DIR,
  type TestDatabase,
} from './test-db.js';

describe.skipIf(!DATABASE_TEST_URL)('runMigrations — Postgres integration', () => {
  let database: TestDatabase | undefined;
  const tempDirs: string[] = [];

  afterEach(async () => {
    await database?.drop();
    database = undefined;
    await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  async function tempMigrations(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'shipit-migrations-'));
    tempDirs.push(dir);
    await Promise.all(Object.entries(files).map(([name, sql]) => writeFile(join(dir, name), sql)));
    return dir;
  }

  const appliedVersions = async (db: TestDatabase['db']) =>
    (
      await db.query<{ version: string }>('SELECT version FROM schema_migrations ORDER BY version')
    ).rows.map((r) => r.version);

  it('applies the real db/migrations to an empty database, then nothing on a second run', async () => {
    database = await createTestDatabase();
    const first = await runMigrations({ db: database.db, dir: MIGRATIONS_DIR });
    expect(first.applied.length).toBeGreaterThan(0);
    expect(first.alreadyApplied).toEqual([]);
    expect((await appliedVersions(database.db)).at(-1)).toBe(EXPECTED_SCHEMA_VERSION);

    const second = await runMigrations({ db: database.db, dir: MIGRATIONS_DIR });
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual(await appliedVersions(database.db));
  });

  it('treats a missing directory as nothing to apply', async () => {
    database = await createTestDatabase();
    const result = await runMigrations({
      db: database.db,
      dir: join(tmpdir(), 'shipit-no-such-dir'),
    });
    expect(result).toEqual({ applied: [], alreadyApplied: [] });
    expect(await appliedVersions(database.db)).toEqual([]);
  });

  it('rolls a failing file back completely and stops there', async () => {
    database = await createTestDatabase();
    const dir = await tempMigrations({
      '0001_ok.sql': 'CREATE TABLE first_table (id integer PRIMARY KEY);',
      '0002_bad.sql': 'CREATE TABLE second_table (id integer PRIMARY KEY); SELECT 1 / 0;',
      '0003_never.sql': 'CREATE TABLE third_table (id integer PRIMARY KEY);',
    });

    await expect(runMigrations({ db: database.db, dir })).rejects.toThrow(/0002_bad\.sql failed/);

    expect(await appliedVersions(database.db)).toEqual(['0001']);
    const tables = await database.db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name LIKE '%\\_table' ORDER BY table_name`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(['first_table']);
  });

  it('picks up where a failed run left off once the file is fixed', async () => {
    database = await createTestDatabase();
    const dir = await tempMigrations({
      '0001_ok.sql': 'CREATE TABLE first_table (id integer PRIMARY KEY);',
      '0002_bad.sql': 'SELECT 1 / 0;',
    });
    await expect(runMigrations({ db: database.db, dir })).rejects.toThrow();
    await writeFile(
      join(dir, '0002_bad.sql'),
      'CREATE TABLE second_table (id integer PRIMARY KEY);',
    );

    const retry = await runMigrations({ db: database.db, dir });
    expect(retry.applied).toEqual(['0002_bad.sql']);
    expect(retry.alreadyApplied).toEqual(['0001']);
  });

  it('applies each file once when two migrators start together', async () => {
    database = await createTestDatabase();
    const dir = await tempMigrations({
      '0001_ok.sql': 'CREATE TABLE first_table (id integer PRIMARY KEY);',
      '0002_ok.sql': 'CREATE TABLE second_table (id integer PRIMARY KEY);',
    });
    // Without the advisory lock both would try CREATE TABLE and one would fail.
    const [a, b] = await Promise.all([
      runMigrations({ db: database.db, dir }),
      runMigrations({ db: database.db, dir }),
    ]);
    expect([...a.applied, ...b.applied].sort()).toEqual(['0001_ok.sql', '0002_ok.sql']);
    expect(await appliedVersions(database.db)).toEqual(['0001', '0002']);
  });

  // DDL that waits for a lock makes every later query on that table wait
  // behind it. A migration that cannot get its lock quickly fails instead, and
  // the deploy is tried again, rather than stalling the application.
  it('gives up on a lock it cannot get instead of queueing behind a long transaction', async () => {
    database = await createTestDatabase();
    const db = database.db;
    const dir = await tempMigrations({ '0001_ok.sql': 'CREATE TABLE busy (id integer);' });
    await runMigrations({ db, dir });
    await writeFile(join(dir, '0002_alter.sql'), 'ALTER TABLE busy ADD COLUMN note text;');

    let release: () => void = () => undefined;
    let locked: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => (locked = resolve));
    const reader = db.tx(async (client) => {
      await client.query('LOCK TABLE busy IN ACCESS SHARE MODE');
      locked();
      await new Promise<void>((resolve) => (release = resolve));
    });
    await holding;

    await expect(runMigrations({ db, dir, lockTimeoutMs: 200 })).rejects.toThrow(
      /0002_alter\.sql failed: .*lock timeout/,
    );
    expect(await appliedVersions(db)).toEqual(['0001']);

    release();
    await reader;
    expect((await runMigrations({ db, dir, lockTimeoutMs: 200 })).applied).toEqual([
      '0002_alter.sql',
    ]);
  });

  // CREATE INDEX CONCURRENTLY is how a table that is being written to gets an
  // index without blocking those writes, and Postgres refuses it inside a
  // transaction. A file that starts with the marker runs outside one.
  it('runs a file marked no-transaction outside a transaction, and records it', async () => {
    database = await createTestDatabase();
    const db = database.db;
    const lines: string[] = [];
    const dir = await tempMigrations({
      '0001_ok.sql': 'CREATE TABLE busy (id integer);',
      '0002_index.sql':
        '-- migrate: no-transaction\nCREATE INDEX CONCURRENTLY IF NOT EXISTS busy_id_idx ON busy (id);',
    });
    const result = await runMigrations({ db, dir, log: (l) => lines.push(l) });
    expect(result.applied).toEqual(['0001_ok.sql', '0002_index.sql']);
    expect(await appliedVersions(db)).toEqual(['0001', '0002']);
    const index = await db.query(
      `SELECT 1 FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'busy_id_idx'`,
    );
    expect(index.rows).toHaveLength(1);
    expect(lines).toContain('applied 0002_index.sql (outside a transaction)');
  });

  it('records nothing for a no-transaction file that fails, so the next run tries it again', async () => {
    database = await createTestDatabase();
    const db = database.db;
    const dir = await tempMigrations({
      '0001_index.sql':
        '-- migrate: no-transaction\nCREATE INDEX CONCURRENTLY missing_idx ON no_such_table (id);',
    });
    await expect(runMigrations({ db, dir })).rejects.toThrow(/0001_index\.sql failed/);
    expect(await appliedVersions(db)).toEqual([]);
  });

  it('logs each applied file', async () => {
    database = await createTestDatabase();
    const lines: string[] = [];
    const dir = await tempMigrations({ '0001_ok.sql': 'CREATE TABLE first_table (id integer);' });
    await runMigrations({ db: database.db, dir, log: (l) => lines.push(l) });
    expect(lines).toEqual(['applied 0001_ok.sql']);
  });
});
