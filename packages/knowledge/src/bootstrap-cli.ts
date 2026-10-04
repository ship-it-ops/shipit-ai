// `pnpm db:bootstrap`: creates the pgvector extension as a superuser. Run once
// per database, before `pnpm db:migrate`. Safe to re-run.
//
// Uses `pg` directly rather than @shipit-ai/agents' pool helper so it runs
// under tsx with no workspace build (the CI integration job calls it straight
// after `pnpm install`), the same way migrate-cli.ts stays self-contained.
import { Pool } from 'pg';
import { ensureVectorExtension } from './bootstrap.js';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_SUPERUSER_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    console.error('db:bootstrap needs DATABASE_URL (or DATABASE_SUPERUSER_URL) to be set.');
    process.exitCode = 2;
    return;
  }
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000 });
  pool.on('error', (err) => console.error(`db:bootstrap: pool error: ${err.message}`));
  try {
    const outcome = await ensureVectorExtension({
      async query<R extends object>(text: string, params?: ReadonlyArray<unknown>) {
        const result = await pool.query(text, params ? [...params] : undefined);
        return { rows: result.rows as R[], rowCount: result.rowCount };
      },
    });
    console.log(
      outcome === 'created'
        ? 'Created the "vector" extension (pgvector).'
        : 'The "vector" extension (pgvector) is already present.',
    );
  } catch (err) {
    const e = err as { code?: string; message?: string };
    // 42501 = insufficient_privilege: the role is not a superuser.
    if (e.code === '42501') {
      console.error(
        'Creating the "vector" extension needs a superuser. Run db:bootstrap with a superuser ' +
          'connection string (DATABASE_SUPERUSER_URL), or ask the database operator to run ' +
          '`CREATE EXTENSION vector;` once.',
      );
    } else {
      console.error(e.message ?? String(err));
    }
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
