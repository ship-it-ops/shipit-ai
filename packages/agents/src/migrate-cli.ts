// CLI entry for applying db/migrations. Used by `pnpm db:migrate` locally and
// in CI, and by the docker-compose `migrate` service. On GKE the infra repo's
// deploy step applies the same files under the same contract instead.
import { resolve } from 'node:path';
import { createDb, createPool } from './db.js';
import { runMigrations } from './migrate.js';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_MIGRATOR_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('db:migrate needs DATABASE_URL (or DATABASE_MIGRATOR_URL) to be set.');
    process.exitCode = 2;
    return;
  }
  const dir = resolve(process.env.MIGRATIONS_DIR ?? 'db/migrations');
  // No statement timeout: a second migrator waits on the advisory lock for as
  // long as the first one runs, and DDL on a large table can take minutes.
  const pool = createPool({ connectionString, max: 1, statementTimeoutMs: 0 });
  try {
    const result = await runMigrations({
      db: createDb(pool),
      dir,
      log: (line) => console.log(line),
    });
    console.log(
      result.applied.length === 0
        ? `Nothing to apply (${result.alreadyApplied.length} already applied) from ${dir}.`
        : `Applied ${result.applied.length} migration(s) from ${dir}.`,
    );
  } catch (err) {
    console.error((err as Error).message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
