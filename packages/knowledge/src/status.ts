import type { SqlClient } from '@shipit-ai/agents';
import { KNOWLEDGE_MIGRATIONS } from './schema-version.js';

/** Versions from KNOWLEDGE_MIGRATIONS that schema_migrations does not have. */
export async function missingKnowledgeMigrations(db: SqlClient): Promise<string[]> {
  const { rows } = await db.query<{ version: string }>(
    'SELECT version FROM schema_migrations WHERE version = ANY($1::text[])',
    [[...KNOWLEDGE_MIGRATIONS]],
  );
  const present = new Set(rows.map((r) => r.version));
  return KNOWLEDGE_MIGRATIONS.filter((v) => !present.has(v));
}
