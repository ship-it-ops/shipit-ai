import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from './db.js';

// Contract shared with the infra repo's deploy-time migration step (see
// docs/agent/briefs/infra-postgres-and-vertex-for-agents.md): files are named
// NNNN_description.sql, applied in order, each in its own transaction, and
// recorded in schema_migrations by their four-digit prefix.
const FILE_PATTERN = /^(\d{4})_([a-z0-9_]+)\.sql$/;

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
}

export interface RunMigrationsResult {
  applied: string[];
  alreadyApplied: string[];
}

export async function runMigrations(opts: RunMigrationsOptions): Promise<RunMigrationsResult> {
  const log = opts.log ?? (() => undefined);
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
        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
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
