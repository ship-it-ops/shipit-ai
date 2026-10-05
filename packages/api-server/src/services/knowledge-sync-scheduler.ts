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
import {
  KnowledgeHarness,
  isRunCutShort,
  type KnowledgeConnector,
  type KnowledgeRunMode,
  type KnowledgeRunResult,
  type RunLimits,
  type SourceContainer,
  type SourcePrincipal,
} from '@shipit-ai/connector-sdk';
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

/** How long a refresh made from an HTTP request may wait on the source. */
const REFRESH_BUDGET_MS = 20_000;

/** Runs a call to the source; a wait it asked for past the deadline becomes RATE_LIMITED. */
async function sourceCall<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (!isRunCutShort(err)) throw err;
    throw new KnowledgeRefreshError(
      'RATE_LIMITED',
      'The source asked to wait before it answers. Try again in a few minutes.',
    );
  }
}

/** Why a container refresh could not run. `code` is safe to show; the route maps it to a status. */
export class KnowledgeRefreshError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'KnowledgeRefreshError';
  }
}

export class KnowledgeSyncScheduler {
  private readonly queue: KnowledgeQueueLike;
  private readonly worker: Worker | null;
  private readonly statuses = new Map<string, SyncRuntimeStatus>();
  // One run per connector at a time (spec §Scheduling): a reconcile that
  // overlapped a poll could prune a document the poll just stored.
  private readonly running = new Map<string, Promise<void>>();
  // Aborted by close(): an in-flight run stops between batches instead of
  // holding shutdown for the rest of its time budget.
  private readonly shutdown = new AbortController();
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
    const type = this.resolveType(cfg.type);
    if (!type?.buildKnowledge) return false;
    return type.knowledgeEnabled ? type.knowledgeEnabled(cfg) : true;
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

  /**
   * Lists the source's containers now and stores the list, so an admin can
   * pick from it without waiting for the nightly reconcile. Returns how many
   * the source has.
   */
  async refreshContainers(connectorId: string): Promise<number> {
    const connector = await this.connect(connectorId);
    const limits = this.refreshLimits();
    const count = await this.listAndStoreContainers(connectorId, connector, limits);
    // The people too, so the first documents of a backfill find their authors;
    // the principal listing otherwise runs only at the nightly reconcile. Only
    // for a connector that has something selected: names, emails and logins
    // are not held for one that indexes nothing. The containers are what was
    // asked for, so a failure here is logged.
    if (await this.opts.store.hasSelection(connectorId)) {
      const sink = new PostgresKnowledgeSink({ connectorId, store: this.opts.store });
      try {
        let page: SourcePrincipal[] = [];
        for await (const principal of connector.listPrincipals(limits)) {
          page.push(principal);
          if (page.length >= 500) {
            await sink.upsertPrincipals(page);
            page = [];
          }
        }
        if (page.length > 0) await sink.upsertPrincipals(page);
      } catch (err) {
        this.log(
          `knowledge: could not list principals for ${connectorId} during a container refresh: ${(err as Error).message}`,
        );
      }
    }
    return count;
  }

  /**
   * Asks the source about ONE container now and stores what it says: the check
   * made before content is indexed on the word of a listing that may be a day
   * old. False when the source no longer has the container. A connector that
   * cannot answer for one container has its whole list refreshed instead.
   */
  async refreshContainer(
    connectorId: string,
    container: Pick<SourceContainer, 'externalId' | 'name'>,
  ): Promise<boolean> {
    const connector = await this.connect(connectorId);
    const limits = this.refreshLimits();
    if (!connector.getContainer) {
      await this.listAndStoreContainers(connectorId, connector, limits);
      return true;
    }
    const lookup = connector.getContainer.bind(connector);
    const fresh = await sourceCall(() =>
      lookup({ externalId: container.externalId, name: container.name }, limits),
    );
    if (!fresh) return false;
    await new PostgresKnowledgeSink({ connectorId, store: this.opts.store }).upsertContainer(fresh);
    return true;
  }

  /** The connector of a knowledge instance, authenticated, for a call made outside a run. */
  private async connect(connectorId: string): Promise<KnowledgeConnector> {
    const cfg = this.opts.registry.get(connectorId); // throws 404 for an unknown id
    const type = this.resolveType(cfg.type);
    if (!type?.buildKnowledge || !this.handles(cfg)) {
      throw new KnowledgeRefreshError(
        'KNOWLEDGE_NOT_ENABLED',
        'Knowledge is not switched on for this connector.',
      );
    }
    const built = await type.buildKnowledge(cfg, this.opts.buildContext);
    if (!built.ok) throw new KnowledgeRefreshError(built.code, built.message);
    const auth = await built.connector.authenticate(built.sdkConfig);
    if (!auth.success) {
      throw new KnowledgeRefreshError('AUTH_FAILED', auth.error ?? 'Authentication failed');
    }
    return built.connector;
  }

  // These calls are made inside an HTTP request. Without a deadline the
  // connector waits out a rate limit for as long as the source says, up to an
  // hour; with one it ends the call, and the request answers RATE_LIMITED.
  private refreshLimits(): RunLimits {
    return { deadline: Date.now() + REFRESH_BUDGET_MS, signal: this.shutdown.signal };
  }

  private async listAndStoreContainers(
    connectorId: string,
    connector: KnowledgeConnector,
    limits: RunLimits,
  ): Promise<number> {
    // The whole list first: an incomplete one must not mark anything gone.
    const all: SourceContainer[] = [];
    await sourceCall(async () => {
      for await (const container of connector.listContainers(limits)) all.push(container);
    });
    await new PostgresKnowledgeSink({ connectorId, store: this.opts.store }).upsertContainers(all);
    return all.length;
  }

  /** The job body. Public so tests (and a future admin "run now") can call it without BullMQ. */
  async runJob(connectorId: string, mode: KnowledgeRunMode): Promise<void> {
    const previous = this.running.get(connectorId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.runJobNow(connectorId, mode));
    this.running.set(connectorId, run);
    try {
      await run;
    } finally {
      if (this.running.get(connectorId) === run) this.running.delete(connectorId);
    }
  }

  private async runJobNow(connectorId: string, mode: KnowledgeRunMode): Promise<void> {
    const startTime = Date.now();
    const startedAt = new Date(startTime).toISOString();
    let cfg: ConnectorInstanceConfig;
    try {
      cfg = this.opts.registry.get(connectorId);
    } catch {
      return; // deleted while queued; do not resurrect its status
    }
    // Knowledge was switched off for this instance after the job was queued.
    if (!this.handles(cfg)) return;
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
    // Anything that throws from here on is still a run an admin must be able
    // to see: record it as failed instead of leaving the history silent.
    let result: KnowledgeRunResult;
    try {
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
        historyDays: type.knowledgeHistoryDays?.(cfg) ?? 365,
        budgetMs: this.opts.budgetMs,
        signal: this.shutdown.signal,
      });
      result = await harness.run(mode);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.failRun(connectorId, startedAt, startTime, message);
      return;
    }
    const notes = [
      ...result.notes,
      ...(result.budgetExhausted ? ['Time budget spent; the next run continues.'] : []),
    ];

    try {
      await this.opts.registry.recordRun(connectorId, {
        startedAt,
        durationMs: result.durationMs,
        status: result.status,
        entitiesSynced: result.documentsSynced,
        errors: result.errors,
        facet: 'knowledge',
        ...(notes.length > 0 ? { notes } : {}),
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
    this.shutdown.abort();
    try {
      await this.worker?.close();
    } finally {
      await this.queue.close();
    }
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
