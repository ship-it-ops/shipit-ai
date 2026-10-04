// BullMQ-backed runner for the KNOWLEDGE facet of connectors. Its own queue, so
// a long backfill never delays a graph sync; Job Schedulers (not legacy
// repeatable jobs), per the agents spec's note that new scheduling code should
// use them. Jobs carry a connector id and a mode, nothing else.
//
//   poll      — on the connector's own schedule; KnowledgeHarness poll mode
//   reconcile — on knowledge.sync.reconcileCron; KnowledgeHarness reconcile mode
//
// Each job builds a fresh connector through the connector-type factory, runs
// the harness against a PostgresKnowledgeSink and records the outcome in the
// registry's run history with facet: 'knowledge'.
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { KnowledgeHarness, type KnowledgeRunMode } from '@shipit-ai/connector-sdk';
import { COMPLETED_JOB_RETENTION, FAILED_JOB_RETENTION } from '@shipit-ai/event-bus';
import { PostgresKnowledgeSink, type KnowledgeStore } from '@shipit-ai/knowledge';
import type { ConnectorInstanceConfig } from '@shipit-ai/shared';
import { getConnectorType } from './connector-types/index.js';
import type { BuildContext, ConnectorType } from './connector-types/types.js';
import type { ConnectorRegistry, SyncRuntimeStatus } from './connector-registry.js';

export const KNOWLEDGE_QUEUE = 'shipit-knowledge-sync';

interface KnowledgeJobData {
  connectorId: string;
  mode: KnowledgeRunMode;
}

/** The slice of a BullMQ Queue this class uses; tests pass a fake. */
export interface KnowledgeQueueLike {
  upsertJobScheduler(
    id: string,
    repeat: { pattern: string },
    job: { name: string; data: KnowledgeJobData },
  ): Promise<unknown>;
  removeJobScheduler(id: string): Promise<boolean>;
  add(name: string, data: KnowledgeJobData, opts: { jobId: string }): Promise<unknown>;
  on(event: 'error', handler: (err: Error) => void): unknown;
  close(): Promise<void>;
}

export interface KnowledgeSyncSchedulerOptions {
  redisUrl: string;
  registry: Pick<ConnectorRegistry, 'get' | 'list' | 'recordRun'>;
  store: KnowledgeStore;
  buildContext: BuildContext;
  /** Per-run wall-clock budget (knowledge.sync.maxRunMinutes). */
  budgetMs: number;
  reconcileCron: string;
  /** Backfill horizon for a connector. Default 365 days. */
  historyDaysOf?: (cfg: ConnectorInstanceConfig) => number;
  /** Status gate: false means "do not fetch now" (database, schema or extension missing). */
  isAvailable: () => Promise<boolean>;
  /** Publishes the worker wake-up after a batch commits. */
  wake?: () => Promise<void>;
  /** Test seams. */
  resolveType?: (type: string) => ConnectorType | undefined;
  queueFactory?: (name: string, connection: ConnectionOptions) => KnowledgeQueueLike;
  /** false (tests): no BullMQ Worker is started; runJob is called directly. */
  startWorker?: boolean;
  queueName?: string;
  concurrency?: number;
  log?: (line: string) => void;
}

function parseRedisUrl(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname || '127.0.0.1',
    port: u.port ? Number(u.port) : 6379,
    password: u.password || undefined,
    username: u.username || undefined,
    db: u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined,
    maxRetriesPerRequest: null,
  };
}

export class KnowledgeSyncScheduler {
  private readonly queue: KnowledgeQueueLike;
  private readonly worker: Worker | null;
  private readonly statuses = new Map<string, SyncRuntimeStatus>();
  private readonly resolveType: (type: string) => ConnectorType | undefined;
  private readonly log: (line: string) => void;

  constructor(private readonly opts: KnowledgeSyncSchedulerOptions) {
    this.resolveType = opts.resolveType ?? getConnectorType;
    this.log = opts.log ?? ((line) => console.warn(line));
    const queueName = opts.queueName ?? KNOWLEDGE_QUEUE;
    const connection = parseRedisUrl(opts.redisUrl);
    const factory =
      opts.queueFactory ??
      ((name, conn) =>
        new Queue(name, {
          connection: conn,
          defaultJobOptions: {
            removeOnComplete: COMPLETED_JOB_RETENTION,
            removeOnFail: FAILED_JOB_RETENTION,
          },
        }) as unknown as KnowledgeQueueLike);
    this.queue = factory(queueName, connection);
    // No listener on 'error' = a process-killing uncaughtException when Redis is
    // at maxmemory (scar apiserver-crashloop-unhandled-bullmq-error-on-oom-redis).
    this.queue.on('error', (err) =>
      this.log(
        `KnowledgeSyncScheduler queue Redis error (knowledge syncs degraded, API stays up): ${err.message}`,
      ),
    );

    if (opts.startWorker === false || opts.queueFactory) {
      this.worker = null;
    } else {
      this.worker = new Worker(
        queueName,
        async (job: Job) => {
          const data = job.data as KnowledgeJobData;
          await this.runJob(data.connectorId, data.mode);
        },
        { connection, concurrency: opts.concurrency ?? 2 },
      );
      this.worker.on('error', (err: Error) =>
        this.log(
          `KnowledgeSyncScheduler worker Redis error (knowledge syncs degraded, API stays up): ${err.message}`,
        ),
      );
      this.worker.on('failed', (job: Job | undefined, err: Error) => {
        const id = (job?.data as KnowledgeJobData | undefined)?.connectorId;
        if (id) this.statuses.set(id, { connectorId: id, state: 'failed', lastError: err.message });
      });
    }
  }

  /** True when the connector's type has a knowledge facet. */
  handles(cfg: ConnectorInstanceConfig): boolean {
    return Boolean(this.resolveType(cfg.type)?.buildKnowledge);
  }

  async start(cfg: ConnectorInstanceConfig): Promise<void> {
    if (!cfg.enabled || !this.handles(cfg)) return;
    await this.queue.upsertJobScheduler(
      `knowledge~${cfg.id}~poll`,
      { pattern: cfg.schedule },
      { name: 'knowledge-poll', data: { connectorId: cfg.id, mode: 'poll' } },
    );
    await this.queue.upsertJobScheduler(
      `knowledge~${cfg.id}~reconcile`,
      { pattern: this.opts.reconcileCron },
      { name: 'knowledge-reconcile', data: { connectorId: cfg.id, mode: 'reconcile' } },
    );
    if (!this.statuses.has(cfg.id)) {
      this.statuses.set(cfg.id, { connectorId: cfg.id, state: 'idle' });
    }
  }

  async stop(connectorId: string): Promise<void> {
    await this.queue.removeJobScheduler(`knowledge~${connectorId}~poll`);
    await this.queue.removeJobScheduler(`knowledge~${connectorId}~reconcile`);
    this.statuses.delete(connectorId);
  }

  async trigger(cfg: ConnectorInstanceConfig, mode: KnowledgeRunMode): Promise<SyncRuntimeStatus> {
    await this.queue.add(
      'knowledge-manual',
      { connectorId: cfg.id, mode },
      { jobId: `knowledge~${cfg.id}~manual~${Date.now()}` },
    );
    const status: SyncRuntimeStatus = {
      connectorId: cfg.id,
      state: 'running',
      startedAt: new Date().toISOString(),
    };
    this.statuses.set(cfg.id, status);
    return status;
  }

  getStatus(connectorId: string): SyncRuntimeStatus {
    return this.statuses.get(connectorId) ?? { connectorId, state: 'idle' };
  }

  /** The job body. Public so tests (and a future admin "run now") can call it without BullMQ. */
  async runJob(connectorId: string, mode: KnowledgeRunMode): Promise<void> {
    const startTime = Date.now();
    const startedAt = new Date(startTime).toISOString();
    let cfg: ConnectorInstanceConfig;
    try {
      cfg = this.opts.registry.get(connectorId);
    } catch {
      return; // deleted while queued; do not resurrect its status
    }
    if (!(await this.opts.isAvailable())) {
      this.log(`knowledge sync for ${connectorId} skipped: the knowledge layer is unavailable`);
      return;
    }
    this.statuses.set(connectorId, { connectorId, state: 'running', startedAt });

    const type = this.resolveType(cfg.type);
    if (!type?.buildKnowledge) {
      await this.failRun(
        connectorId,
        startedAt,
        startTime,
        `Connector type "${cfg.type}" has no knowledge facet.`,
      );
      return;
    }
    const built = await type.buildKnowledge(cfg, this.opts.buildContext);
    if (!built.ok) {
      await this.failRun(connectorId, startedAt, startTime, built.message);
      return;
    }

    const sink = new PostgresKnowledgeSink({
      connectorId,
      store: this.opts.store,
      wake: this.opts.wake,
      log: this.log,
    });
    const harness = new KnowledgeHarness(built.connector, sink, built.sdkConfig, {
      historyDays: this.opts.historyDaysOf?.(cfg) ?? 365,
      budgetMs: this.opts.budgetMs,
    });
    const result = await harness.run(mode);

    try {
      await this.opts.registry.recordRun(connectorId, {
        startedAt,
        durationMs: result.durationMs,
        status: result.status,
        entitiesSynced: result.documentsSynced,
        errors: result.errors,
        facet: 'knowledge',
        ...(result.budgetExhausted
          ? { notes: ['Time budget spent; the next poll continues the backfill.'] }
          : {}),
      });
    } catch (err) {
      this.log(
        `failed to persist knowledge run history for ${connectorId}: ${(err as Error).message}`,
      );
    }

    this.statuses.set(connectorId, {
      connectorId,
      startedAt,
      state:
        result.status === 'success'
          ? 'idle'
          : result.authFailed || result.status === 'partial'
            ? 'degraded'
            : 'failed',
      lastError: result.errors[0],
    });
  }

  async close(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }

  private async failRun(
    connectorId: string,
    startedAt: string,
    startTime: number,
    message: string,
  ): Promise<void> {
    try {
      await this.opts.registry.recordRun(connectorId, {
        startedAt,
        durationMs: Date.now() - startTime,
        status: 'failed',
        entitiesSynced: 0,
        errors: [message],
        facet: 'knowledge',
      });
    } catch (err) {
      this.log(
        `failed to persist knowledge run history for ${connectorId}: ${(err as Error).message}`,
      );
    }
    this.statuses.set(connectorId, { connectorId, state: 'failed', startedAt, lastError: message });
  }
}
