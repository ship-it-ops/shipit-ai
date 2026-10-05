import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db, SqlClient } from './db.js';

// Contract shared with the infra repo's deploy-time migration step (see
// docs/agent/briefs/infra-postgres-and-vertex-for-agents.md): files are named
// NNNN_description.sql, applied in order, each in its own transaction, and
// recorded in schema_migrations by their four-digit prefix.
//
// Two rules keep a migration from stalling a database that is in use:
// - Every file runs under a lock timeout. DDL that waits for a lock makes all
//   later queries on that table wait behind it, so a file that cannot get its
//   lock fails, and the deploy is tried again, instead.
// - A file whose first line is the marker below runs OUTSIDE a transaction.
//   That is for CREATE INDEX CONCURRENTLY, which indexes a table without
//   blocking writes to it and which Postgres refuses inside a transaction.
//   Such a file holds one statement (several would run as one implicit
//   transaction), written with IF NOT EXISTS so that a second run after a
//   failed recording is harmless. It is recorded only after it succeeds and
//   only while the schema holds no invalid index: a concurrent build that
//   fails leaves one behind, which IF NOT EXISTS would otherwise wave through.
const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;
const NO_TRANSACTION_MARKER = /^--\s*migrate:\s*no-transaction\s*$/;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;

/** Whether a migration file asks, on its first line, to run outside a transaction. */
export function runsOutsideTransaction(sql: string): boolean {
  return NO_TRANSACTION_MARKER.test(sql.split(/\r?\n/, 1)[0] ?? '');
}

// Arbitrary constant; every migrator takes this advisory lock so two of them
// cannot interleave.
export const MIGRATION_LOCK_KEY = 4815162342;

export class MigrationPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationPlanError';
  }
}

export function parseMigrationFilename(
  filename: string,
): { version: string; description: string } | null {
  const match = FILE_PATTERN.exec(filename);
  return match ? { version: match[1]!, description: match[2]! } : null;
}

export interface MigrationPlan {
  /** Filenames to apply, in order. */
  pending: string[];
  /** Versions recorded in the database that have no file here (an older checkout). */
  unknownApplied: string[];
}

export function planMigrations(
  filenames: ReadonlyArray<string>,
  applied: ReadonlyArray<string>,
): MigrationPlan {
  const byVersion = new Map<string, string>();
  for (const filename of filenames) {
    if (!filename.endsWith('.sql')) continue; // README.md and friends are not migrations
    const parsed = parseMigrationFilename(filename);
    if (!parsed) {
      throw new MigrationPlanError(
        `"${filename}" is not a valid migration name (expected NNNN_description.sql, lower-case)`,
      );
    }
    const clash = byVersion.get(parsed.version);
    if (clash) {
      throw new MigrationPlanError(
        `Two migrations share version ${parsed.version}: "${clash}" and "${filename}"`,
      );
    }
    byVersion.set(parsed.version, filename);
  }

  const appliedSet = new Set(applied);
  const highestApplied = applied.reduce((max, v) => (v > max ? v : max), '');
  const pending: string[] = [];
  for (const version of [...byVersion.keys()].sort()) {
    if (appliedSet.has(version)) continue;
    if (version < highestApplied) {
      throw new MigrationPlanError(
        `Migration ${byVersion.get(version)} is older than the newest applied version ` +
          `${highestApplied}. Migrations are forward-only; give it a higher number.`,
      );
    }
    pending.push(byVersion.get(version)!);
  }

  return {
    pending,
    unknownApplied: applied.filter((v) => !byVersion.has(v)).sort(),
  };
}

/** Lists the directory, or returns [] when it does not exist yet. */
export async function listMigrationFiles(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

export interface RunMigrationsOptions {
  db: Db;
  dir: string;
  log?: (line: string) => void;
  /**
   * How long a statement in a migration may wait for a lock before the file
   * fails. Default 5 s. Not applied to files that run outside a transaction:
   * a concurrent index build waits for older transactions without blocking
   * anyone, and cutting that wait short leaves an invalid index behind.
   */
  lockTimeoutMs?: number;
}

// A concurrent index build that fails leaves its index behind, marked
// invalid, and `IF NOT EXISTS` then skips it on the next run. Recording the
// file as applied over that would leave an index Postgres never uses and, for
// a unique one, never enforces. So a file that ran outside a transaction is
// recorded only while the schema holds no invalid index.
//
// Any invalid index in the schema refuses, not only one the file names: which
// those are cannot be told without reading SQL, and getting it wrong is the
// silent failure this check exists to prevent. The cost is that an invalid
// index left by something else (a `REINDEX CONCURRENTLY` that failed, a build
// someone else has running) holds the file up until it is dropped or done.
async function refuseInvalidIndexes(client: SqlClient): Promise<void> {
  // Schema-qualified and quoted: the message is pasted into a session whose
  // search path is not this one.
  const { rows } = await client.query<{ name: string }>(
    `SELECT format('%I.%I', n.nspname, c.relname) AS name
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT i.indisvalid AND n.nspname = current_schema()
      ORDER BY c.relname`,
  );
  if (rows.length === 0) return;
  const names = rows.map((r) => r.name);
  throw new Error(
    `the schema holds an invalid index (${names.join(', ')}). A concurrent build that did not ` +
      `finish leaves one behind, and IF NOT EXISTS then skips it. Unless a build of it is ` +
      `still running, drop it and run the migration again: ` +
      names.map((name) => `DROP INDEX CONCURRENTLY ${name};`).join(' '),
  );
}

export interface RunMigrationsResult {
  applied: string[];
  alreadyApplied: string[];
}

export async function runMigrations(opts: RunMigrationsOptions): Promise<RunMigrationsResult> {
  const log = opts.log ?? (() => undefined);
  const lockTimeoutMs = Math.max(0, Math.floor(opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS));
  const filenames = await listMigrationFiles(opts.dir);

  return opts.db.withClient(async (client) => {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      await client.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
           version    text PRIMARY KEY,
           applied_at timestamptz NOT NULL DEFAULT now()
         )`,
      );
      const { rows } = await client.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      );
      const alreadyApplied = rows.map((r) => r.version);
      const plan = planMigrations(filenames, alreadyApplied);
      if (plan.unknownApplied.length > 0) {
        log(`note: the database has versions with no file here: ${plan.unknownApplied.join(', ')}`);
      }

      const applied: string[] = [];
      for (const filename of plan.pending) {
        const sql = await readFile(join(opts.dir, filename), 'utf8');
        const { version } = parseMigrationFilename(filename)!;
        const record = 'INSERT INTO schema_migrations (version) VALUES ($1)';
        if (runsOutsideTransaction(sql)) {
          try {
            await client.query(sql);
            await refuseInvalidIndexes(client);
            await client.query(record, [version]);
          } catch (err) {
            throw new Error(`Migration ${filename} failed: ${(err as Error).message}`);
          }
          applied.push(filename);
          log(`applied ${filename} (outside a transaction)`);
          continue;
        }
        await client.query('BEGIN');
        try {
          // SET takes no parameters; the value is a number of our own making.
          await client.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}ms'`);
          await client.query(sql);
          await client.query(record, [version]);
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw new Error(`Migration ${filename} failed: ${(err as Error).message}`);
        }
        applied.push(filename);
        log(`applied ${filename}`);
      }
      return { applied, alreadyApplied };
    } finally {
      await client
        .query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY])
        .catch(() => undefined);
    }
  });
}
