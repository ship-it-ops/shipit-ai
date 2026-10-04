// Feature gating for user-defined agents. Answers "can this instance store
// agent definitions?" and "can it run them?" from live checks, so a missing
// prerequisite turns the feature off with a named reason instead of crashing a
// process or returning a 500.
import type { AiConfig } from '@shipit-ai/shared';
import { EXPECTED_SCHEMA_VERSION, RUNNER_HEARTBEAT_KEY, type Db } from '@shipit-ai/agents';

// Written by agent-runner every 15s with a 60s TTL; absent means no runner.
// Defined in @shipit-ai/agents, which the runner also writes it from.
export { RUNNER_HEARTBEAT_KEY };

export type AiCheckName = 'enabled' | 'database' | 'schema' | 'models' | 'runner';

export interface AiCheck {
  name: AiCheckName;
  ok: boolean;
  /** Safe to show to any signed-in user: never contains a host, URL or driver message. */
  detail: string;
}

export interface AiStatus {
  /** Every prerequisite for running an agent is in place. */
  available: boolean;
  /** Enough is in place to store and edit agent definitions. */
  definitionsAvailable: boolean;
  checks: AiCheck[];
}

export interface AiStatusServiceOptions {
  config: AiConfig;
  /** null when no database URL is configured. */
  db: Db | null;
  /** null when Redis is not configured. Only `get` is used. */
  redis: { get(key: string): Promise<string | null> } | null;
  /** How long a computed status is reused. Defaults to 5s; tests pass 0. */
  cacheMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

const pass = (name: AiCheckName, detail: string): AiCheck => ({ name, ok: true, detail });
const fail = (name: AiCheckName, detail: string): AiCheck => ({ name, ok: false, detail });

export class AiStatusService {
  private cached: { at: number; status: AiStatus } | null = null;

  constructor(private readonly opts: AiStatusServiceOptions) {}

  async status(): Promise<AiStatus> {
    const now = (this.opts.now ?? Date.now)();
    const ttl = this.opts.cacheMs ?? 5_000;
    if (this.cached && now - this.cached.at < ttl) return this.cached.status;
    const status = await this.compute();
    this.cached = { at: now, status };
    return status;
  }

  private async compute(): Promise<AiStatus> {
    const enabled = this.opts.config.enabled
      ? pass('enabled', 'Agent features are switched on.')
      : fail('enabled', 'Agent features are switched off (ai.enabled is false).');
    const [database, schema] = await this.checkDatabase();
    const checks = [enabled, database, schema, this.checkModels(), await this.checkRunner()];
    return {
      available: checks.every((c) => c.ok),
      definitionsAvailable: enabled.ok && database.ok && schema.ok,
      checks,
    };
  }

  private async checkDatabase(): Promise<[AiCheck, AiCheck]> {
    const { db } = this.opts;
    if (!db) {
      return [
        fail('database', 'No database is configured (ai.database.url is empty).'),
        fail('schema', 'No database to check.'),
      ];
    }
    try {
      const { rows } = await db.query<{ version: string | null }>(
        'SELECT max(version) AS version FROM schema_migrations',
      );
      const version = rows[0]?.version ?? null;
      const database = pass('database', 'Connected.');
      if (version === null) {
        return [
          database,
          fail('schema', `No migrations are applied. This build needs ${EXPECTED_SCHEMA_VERSION}.`),
        ];
      }
      if (version < EXPECTED_SCHEMA_VERSION) {
        return [
          database,
          fail(
            'schema',
            `The schema is at ${version}. This build needs ${EXPECTED_SCHEMA_VERSION}; run the migration step.`,
          ),
        ];
      }
      return [database, pass('schema', `The schema is at ${version}.`)];
    } catch (err) {
      const e = err as { code?: string; message?: string };
      // 42P01 = undefined_table: we connected, but nothing has been migrated.
      if (e.code === '42P01') {
        return [
          pass('database', 'Connected.'),
          fail(
            'schema',
            `No migrations are applied. This build needs ${EXPECTED_SCHEMA_VERSION}; run the migration step.`,
          ),
        ];
      }
      this.opts.log?.(`ai-status: database check failed: ${e.message ?? String(err)}`);
      return [
        fail('database', 'The database is not reachable.'),
        fail('schema', 'The database is not reachable.'),
      ];
    }
  }

  private checkModels(): AiCheck {
    const { vertex, models } = this.opts.config;
    if (!vertex.project)
      return fail('models', 'No Vertex AI project is configured (ai.vertex.project).');
    if (models.length === 0) return fail('models', 'No models are configured (ai.models).');
    return pass('models', `${models.length} model(s) configured.`);
  }

  private async checkRunner(): Promise<AiCheck> {
    const { redis } = this.opts;
    if (!redis) return fail('runner', 'Redis is not configured, so no runner can be seen.');
    try {
      const beat = await redis.get(RUNNER_HEARTBEAT_KEY);
      return beat
        ? pass('runner', 'The agent runner is alive.')
        : fail('runner', 'No heartbeat from the agent runner in the last minute.');
    } catch (err) {
      this.opts.log?.(`ai-status: runner check failed: ${(err as Error).message}`);
      return fail('runner', 'The agent runner could not be checked.');
    }
  }
}
