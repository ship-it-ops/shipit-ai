// Feature gating for the knowledge layer, the way AiStatusService gates agents:
// live checks with a short cache, details safe to show any signed-in user,
// never a host, URL or driver message.
import type { Db } from '@shipit-ai/agents';
import {
  hasVectorExtension,
  missingKnowledgeMigrations,
  type KnowledgeStore,
} from '@shipit-ai/knowledge';
import type { AiConfig, KnowledgeConfig } from '@shipit-ai/shared';

/** Written by knowledge-worker every 15s with a 60s TTL. Absent = no worker. */
export const WORKER_HEARTBEAT_KEY = 'shipit-knowledge-worker-heartbeat';
export const EXPECTED_EMBEDDING_DIMENSIONS = 768;

export type KnowledgeCheckName =
  'enabled' | 'database' | 'schema' | 'extension' | 'embedding' | 'worker';

export interface KnowledgeCheck {
  name: KnowledgeCheckName;
  ok: boolean;
  detail: string;
}

export interface KnowledgeStatus {
  /** Everything, including a live worker: content can be fetched, indexed and searched. */
  available: boolean;
  /** Enough to fetch and store documents; indexing waits for the worker. */
  ingestionAvailable: boolean;
  checks: KnowledgeCheck[];
  /** Documents by index status, when a store is wired and the schema is present. */
  counts?: Record<string, number>;
}

export interface KnowledgeStatusServiceOptions {
  knowledge: KnowledgeConfig;
  ai: AiConfig;
  /** null when no database URL is configured. */
  db: Db | null;
  /** null when the schema is not there yet or in tests. Only counts are read. */
  store: Pick<KnowledgeStore, 'countsByIndexStatus'> | null;
  /** null when Redis is not configured. Only `get` is used. */
  redis: { get(key: string): Promise<string | null> } | null;
  cacheMs?: number;
  /** How long the worker check waits for Redis before giving up. Default 2 000. */
  redisTimeoutMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

const pass = (name: KnowledgeCheckName, detail: string): KnowledgeCheck => ({
  name,
  ok: true,
  detail,
});
const fail = (name: KnowledgeCheckName, detail: string): KnowledgeCheck => ({
  name,
  ok: false,
  detail,
});

export class KnowledgeStatusService {
  private cached: { at: number; status: KnowledgeStatus } | null = null;
  private inFlight: Promise<KnowledgeStatus> | null = null;

  constructor(private readonly opts: KnowledgeStatusServiceOptions) {}

  async status(): Promise<KnowledgeStatus> {
    const now = (this.opts.now ?? Date.now)();
    const ttl = this.opts.cacheMs ?? 5_000;
    if (this.cached && now - this.cached.at < ttl) return this.cached.status;
    // Callers that arrive while a computation is running share it, so a slow
    // dependency costs one set of probes, not one per request.
    this.inFlight ??= this.compute()
      .then((status) => {
        this.cached = { at: now, status };
        return status;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  async ingestionAvailable(): Promise<boolean> {
    return (await this.status()).ingestionAvailable;
  }

  private async compute(): Promise<KnowledgeStatus> {
    const enabled = this.opts.knowledge.enabled
      ? pass('enabled', 'The knowledge layer is switched on.')
      : fail('enabled', 'The knowledge layer is switched off (knowledge.enabled is false).');
    const [database, schema, extension] = await this.checkDatabase();
    const embedding = this.checkEmbedding();
    const worker = await this.checkWorker();
    const checks = [enabled, database, schema, extension, embedding, worker];
    const ingestionAvailable = enabled.ok && database.ok && schema.ok && extension.ok;
    const status: KnowledgeStatus = {
      available: checks.every((c) => c.ok),
      ingestionAvailable,
      checks,
    };
    if (ingestionAvailable && this.opts.store) {
      try {
        status.counts = await this.opts.store.countsByIndexStatus();
      } catch (err) {
        this.opts.log?.(`knowledge-status: counts failed: ${(err as Error).message}`);
      }
    }
    return status;
  }

  private async checkDatabase(): Promise<[KnowledgeCheck, KnowledgeCheck, KnowledgeCheck]> {
    const { db } = this.opts;
    if (!db) {
      return [
        fail('database', 'No database is configured (ai.database.url is empty).'),
        fail('schema', 'No database to check.'),
        fail('extension', 'No database to check.'),
      ];
    }
    let missing: string[];
    try {
      missing = await missingKnowledgeMigrations(db);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      // 42P01 = undefined_table: connected, nothing migrated yet.
      if (e.code === '42P01') missing = ['(none applied)'];
      else {
        this.opts.log?.(`knowledge-status: database check failed: ${e.message ?? String(err)}`);
        const down = 'The database is not reachable.';
        return [fail('database', down), fail('schema', down), fail('extension', down)];
      }
    }
    const database = pass('database', 'Connected.');
    const schema =
      missing.length === 0
        ? pass('schema', 'The knowledge tables are present.')
        : fail(
            'schema',
            `Knowledge migrations missing: ${missing.join(', ')}. Run the migration step.`,
          );
    let extension: KnowledgeCheck;
    try {
      extension = (await hasVectorExtension(db))
        ? pass('extension', 'pgvector is installed.')
        : fail(
            'extension',
            'The pgvector extension is not installed. A superuser must run the bootstrap step (pnpm db:bootstrap locally).',
          );
    } catch (err) {
      this.opts.log?.(`knowledge-status: extension check failed: ${(err as Error).message}`);
      extension = fail('extension', 'The pgvector extension could not be checked.');
    }
    return [database, schema, extension];
  }

  private checkEmbedding(): KnowledgeCheck {
    if (!this.opts.ai.vertex.project) {
      return fail('embedding', 'No Vertex AI project is configured (ai.vertex.project).');
    }
    const { model, dimensions } = this.opts.knowledge.embedding;
    if (dimensions !== EXPECTED_EMBEDDING_DIMENSIONS) {
      return fail(
        'embedding',
        `knowledge.embedding.dimensions is ${dimensions}; the schema stores ${EXPECTED_EMBEDDING_DIMENSIONS}.`,
      );
    }
    return pass('embedding', `${model} at ${dimensions} dimensions.`);
  }

  private async checkWorker(): Promise<KnowledgeCheck> {
    const { redis } = this.opts;
    if (!redis) return fail('worker', 'Redis is not configured, so no worker can be seen.');
    try {
      // ioredis queues commands while it is disconnected, so without a limit
      // this read (and with it the whole status, and the sync gate behind it)
      // would wait for as long as Redis is down.
      const beat = await withTimeout(
        redis.get(WORKER_HEARTBEAT_KEY),
        this.opts.redisTimeoutMs ?? 2_000,
      );
      return beat
        ? pass('worker', 'The knowledge worker is alive.')
        : fail('worker', 'No heartbeat from the knowledge worker in the last minute.');
    } catch (err) {
      this.opts.log?.(`knowledge-status: worker check failed: ${(err as Error).message}`);
      return fail('worker', 'The knowledge worker could not be checked.');
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no answer from Redis in ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}
