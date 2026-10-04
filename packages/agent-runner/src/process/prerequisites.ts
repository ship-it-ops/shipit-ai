import type { Db } from '@shipit-ai/agents';

/** The highest applied migration, or null when the database was never migrated. */
export async function schemaVersion(db: Db): Promise<string | null> {
  try {
    const { rows } = await db.query<{ version: string | null }>(
      'SELECT max(version) AS version FROM schema_migrations',
    );
    return rows[0]?.version ?? null;
  } catch (err) {
    // 42P01 = undefined_table: connected, but nothing has been migrated.
    if ((err as { code?: string }).code === '42P01') return null;
    throw err;
  }
}

/**
 * Waits until the database schema is at least `expected`. The infra repo
 * applies migrations at deploy, so a runner can briefly start against an older
 * schema; it waits and says why instead of crashing (design §Feature gating:
 * no process exits because an agent prerequisite is missing).
 */
export async function waitForSchema(
  db: Db,
  expected: string,
  opts: {
    sleep?: (ms: number) => Promise<void>;
    log?: (message: string) => void;
    retryMs?: number;
  } = {},
): Promise<void> {
  const sleep = opts.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const log = opts.log ?? console.warn;
  for (;;) {
    let reason: string;
    try {
      const version = await schemaVersion(db);
      if (version !== null && version >= expected) return;
      reason =
        version === null
          ? 'the database is not migrated'
          : `the schema is at ${version}, this runner needs ${expected}`;
    } catch (err) {
      reason = `the database is not reachable (${(err as Error).message})`;
    }
    log(`Agent runner waiting: ${reason}. Retrying in a minute.`);
    await sleep(opts.retryMs ?? 60_000);
  }
}
