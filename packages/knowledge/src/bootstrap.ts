// pgvector is a baseline requirement of the Postgres instance (spec decision
// 10). The extension is NOT trusted, so only a superuser can create it: the
// infra repo does so on GKE, `pnpm db:bootstrap` locally (the compose `shipit`
// user is the superuser), and the test harness per suite. Never from a
// migration file — shipit_migrator owns the schema and nothing more.
import type { SqlClient } from '@shipit-ai/agents';

export const VECTOR_EXTENSION = 'vector';

export async function hasVectorExtension(db: SqlClient): Promise<boolean> {
  const { rows } = await db.query<{ extversion: string }>(
    'SELECT extversion FROM pg_extension WHERE extname = $1',
    [VECTOR_EXTENSION],
  );
  return rows.length > 0;
}

export async function ensureVectorExtension(db: SqlClient): Promise<'created' | 'present'> {
  if (await hasVectorExtension(db)) return 'present';
  await db.query('CREATE EXTENSION IF NOT EXISTS vector');
  return 'created';
}
