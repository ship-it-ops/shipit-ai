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
  /** How long a refresh made from an HTTP request may take. Default 60 s. */
  refreshTimeoutMs?: number;
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

/** The longest wait the source may ask for (a rate limit) in a refresh made from an HTTP request. */
const REFRESH_BUDGET_MS = 20_000;
/** How long such a refresh may take in all before the source is given up on. */
const REFRESH_TIMEOUT_MS = 60_000;

/** One refresh: the limits the connector is given, and whether its time ran out. */
interface RefreshLimits {
  run: RunLimits & { signal: AbortSignal };
  timedOut(): boolean;
}

/**
 * `work`, or a rejection with the signal's reason the moment it aborts,
 * whichever comes first. The work is not stopped by this (the signal it was
 * given does that, if it listens); its answer is simply no longer waited for.
 */
function orAborted<T>(signal: AbortSignal, work: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** `source`, ended with the signal's reason the moment it aborts. */
async function* untilAborted<T>(signal: AbortSignal, source: AsyncIterable<T>): AsyncGenerator<T> {
  const iterator = source[Symbol.asyncIterator]();
  let ended = false;
  try {
    for (;;) {
      // Stopped between two questions: the next one is not asked.
      signal.throwIfAborted();
      const step = await orAborted(signal, iterator.next());
      if (step.done) {
        ended = true;
        return;
      }
      yield step.value;
    }
  } finally {
    // Not waited for: a source that took no notice of the signal may never answer.
    if (!ended) void Promise.resolve(iterator.return?.()).catch(() => undefined);
  }
}

/**
 * Runs a call to the source for a refresh, for no longer than the refresh
 * lasts: the call is given up on when the refresh's signal aborts, whether or
 * not the connector takes notice of it. A wait the source asked for past the
 * deadline becomes RATE_LIMITED; a source that did not answer in time becomes
 * SOURCE_TIMEOUT.
 */
async function sourceCall<T>(limits: RefreshLimits, call: () => Promise<T>): Promise<T> {
  try {
    // Stopped, or out of time, before this call: it is not made.
    limits.run.signal.throwIfAborted();
    return await orAborted(limits.run.signal, call());
  } catch (err) {
    if (isRunCutShort(err)) {
      throw new KnowledgeRefreshError(
        'RATE_LIMITED',
        'The source asked to wait before it answers. Try again in a few minutes.',
      );
    }
    if (limits.timedOut()) {
      throw new KnowledgeRefreshError(
        'SOURCE_TIMEOUT',
        'The source did not answer in time. Try again.',
      );
    }
    throw err;
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

const beingDeleted = (): KnowledgeRefreshError =>
  new KnowledgeRefreshError('CONNECTOR_BEING_DELETED', 'This connector is being deleted.');

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
  // One per run in flight, so that the run of a connector being deleted can
  // be stopped without stopping the others.
  private readonly inFlight = new Map<string, AbortController>();
  // The refreshes made from the API that are in flight, per connector: a
  // delete stops them and waits for them, as it does for the run.
  private readonly refreshes = new Map<
    string,
    Set<{ stop: AbortController; over: Promise<void> }>
  >();
  // Connectors whose delete is in progress: no run, and no refresh, for them.
  private readonly retiring = new Set<string>();
  // connector id → the creation time its store rows are known to belong to.
  private readonly lives = new Map<string, string>();
  // The checks of that being made right now, per connector: one at a time,
  // and a delete waits for it.
  private readonly lifeChecks = new Map<string, Promise<void>>();
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
    return this.asRefresh(connectorId, async (limits) => {
      const connector = await this.connect(connectorId, limits);
      const listed = await this.listAndStoreContainers(connectorId, connector, limits);
      // The people too, so the first documents of a backfill find their
      // authors; the principal listing otherwise runs only at the nightly
      // reconcile. Only for a connector that has something selected: names,
      // emails and logins are not held for one that indexes nothing. The
      // containers are what was asked for, so a failure here is logged.
      if (await this.opts.store.hasSelection(connectorId)) {
        const sink = new PostgresKnowledgeSink({ connectorId, store: this.opts.store });
        try {
          let page: SourcePrincipal[] = [];
          const people = untilAborted(limits.run.signal, connector.listPrincipals(limits.run));
          for await (const principal of people) {
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
      return listed.length;
    });
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
    return this.asRefresh(connectorId, async (limits) => {
      const connector = await this.connect(connectorId, limits);
      if (!connector.getContainer) {
        const listed = await this.listAndStoreContainers(connectorId, connector, limits);
        return listed.some((c) => c.externalId === container.externalId);
      }
      const lookup = connector.getContainer.bind(connector);
      const fresh = await sourceCall(limits, () =>
        lookup({ externalId: container.externalId, name: container.name }, limits.run),
      );
      if (!fresh) return false;
      await new PostgresKnowledgeSink({ connectorId, store: this.opts.store }).upsertContainer(
        fresh,
      );
      return true;
    });
  }

  /**
   * Makes sure the rows the store holds under the connector's id are this
   * connector's (see `ensureLife`). For a route about to show or change the
   * connector's containers; a run and a refresh check by themselves.
   */
  async checkLife(connectorId: string): Promise<void> {
    const cfg = this.opts.registry.get(connectorId); // throws 404 for an unknown id
    // Being deleted: its rows are on their way out, whoever they belonged to.
    if (this.retiring.has(connectorId)) return;
    await this.ownRows(cfg);
  }

  /**
   * A delete of the connector is starting: its run and its refreshes in flight
   * are stopped and waited for, as is a check of whose rows its id holds, and
   * until `unretire` none of the three is made for it. One still at work
   * would write to the store after the delete had cleared the connector.
   */
  async retire(connectorId: string): Promise<void> {
    this.retiring.add(connectorId);
    this.inFlight.get(connectorId)?.abort();
    const refreshes = [...(this.refreshes.get(connectorId) ?? [])];
    for (const refresh of refreshes) refresh.stop.abort();
    await Promise.all([
      (this.running.get(connectorId) ?? Promise.resolve()).catch(() => undefined),
      (this.lifeChecks.get(connectorId) ?? Promise.resolve()).catch(() => undefined),
      ...refreshes.map((refresh) => refresh.over),
    ]);
  }

  /**
   * The delete is over. If it went through, the id is free to be used again;
   * if it did not, the connector may run again. Either way the store is asked
   * afresh whose rows the id holds: a delete that cleared them and then
   * failed took the record of the connector's life with them.
   */
  unretire(connectorId: string): void {
    this.retiring.delete(connectorId);
    this.lives.delete(connectorId);
  }

  // A refresh made from the API: tracked while it lasts, with a signal of its
  // own that the connector's delete aborts (see `retire`). Its limits start
  // here, so that the time allowed covers authentication too.
  private async asRefresh<T>(
    connectorId: string,
    work: (limits: RefreshLimits) => Promise<T>,
  ): Promise<T> {
    const stop = new AbortController();
    let end: () => void = () => undefined;
    const refresh = { stop, over: new Promise<void>((resolve) => (end = resolve)) };
    const mine = this.refreshes.get(connectorId) ?? new Set();
    this.refreshes.set(connectorId, mine.add(refresh));
    try {
      return await work(this.refreshLimits(stop.signal));
    } catch (err) {
      // Stopped by the delete, whatever the call it interrupted made of that.
      if (stop.signal.aborted) throw beingDeleted();
      throw err;
    } finally {
      mine.delete(refresh);
      if (mine.size === 0 && this.refreshes.get(connectorId) === mine) {
        this.refreshes.delete(connectorId);
      }
      end();
    }
  }

  /** The connector of a knowledge instance, authenticated, for a call made outside a run. */
  private async connect(connectorId: string, limits: RefreshLimits): Promise<KnowledgeConnector> {
    const cfg = this.opts.registry.get(connectorId); // throws 404 for an unknown id
    this.refuseIfRetiring(connectorId);
    const type = this.resolveType(cfg.type);
    if (!type?.buildKnowledge || !this.handles(cfg)) {
      throw new KnowledgeRefreshError(
        'KNOWLEDGE_NOT_ENABLED',
        'Knowledge is not switched on for this connector.',
      );
    }
    await this.ownRows(cfg);
    const built = await type.buildKnowledge(cfg, this.opts.buildContext);
    if (!built.ok) throw new KnowledgeRefreshError(built.code, built.message);
    const auth = await sourceCall(limits, () => built.connector.authenticate(built.sdkConfig));
    if (!auth.success) {
      throw new KnowledgeRefreshError('AUTH_FAILED', auth.error ?? 'Authentication failed');
    }
    return built.connector;
  }

  /** `ensureLife` for a caller that answers an HTTP request: a store that is down has a code. */
  private async ownRows(cfg: ConnectorInstanceConfig): Promise<void> {
    try {
      await this.ensureLife(cfg);
    } catch (err) {
      this.log(`knowledge: could not check ${cfg.id} against the store: ${(err as Error).message}`);
      throw new KnowledgeRefreshError(
        'KNOWLEDGE_UNAVAILABLE',
        'The knowledge database could not be reached. Try again.',
      );
    }
  }

  /**
   * Before anything is fetched, shown or changed for a connector: whatever an
   * earlier connector with the same id left in the store is cleared. Ids are
   * chosen by the caller and can be used again, and a connector deleted while
   * the knowledge layer was off left its rows behind. The store tells the two
   * apart by the connector's creation time, and remembers it. A connector
   * that predates the field is left alone.
   */
  private ensureLife(cfg: ConnectorInstanceConfig): Promise<void> {
    const bornAt = cfg.createdAt;
    if (!bornAt || this.lives.get(cfg.id) === bornAt) return Promise.resolve();
    // Requests that need the check at the same moment share it.
    const underWay = this.lifeChecks.get(cfg.id);
    if (underWay) return underWay;
    const check = Promise.resolve()
      .then(() => this.opts.store.beginConnectorLife(cfg.id, bornAt, 'system'))
      .then((cleared) => {
        this.lives.set(cfg.id, bornAt);
        if (cleared) {
          this.log(
            `knowledge: ${cfg.id} is a new connector under an id used before; cleared ` +
              `${cleared} ${cleared === 1 ? 'row' : 'rows'} the earlier one left`,
          );
        }
      })
      .finally(() => {
        if (this.lifeChecks.get(cfg.id) === check) this.lifeChecks.delete(cfg.id);
      });
    this.lifeChecks.set(cfg.id, check);
    return check;
  }

  // These calls are made inside an HTTP request. Two bounds: a wait the source
  // asks for (a rate limit) longer than the deadline ends the call, where the
  // connector would otherwise sleep for up to an hour; and a source that does
  // not answer at all is given up on when the time for the whole refresh is
  // up. `stop` is the refresh's own signal, aborted by the connector's delete.
  private refreshLimits(stop: AbortSignal): RefreshLimits {
    const timeout = AbortSignal.timeout(this.opts.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS);
    return {
      run: {
        deadline: Date.now() + REFRESH_BUDGET_MS,
        signal: AbortSignal.any([this.shutdown.signal, stop, timeout]),
      },
      timedOut: () => timeout.aborted,
    };
  }

  private async listAndStoreContainers(
    connectorId: string,
    connector: KnowledgeConnector,
    limits: RefreshLimits,
  ): Promise<SourceContainer[]> {
    // The whole list first: an incomplete one must not mark anything gone.
    const all: SourceContainer[] = [];
    await sourceCall(limits, async () => {
      for await (const container of connector.listContainers(limits.run)) all.push(container);
    });
    await new PostgresKnowledgeSink({ connectorId, store: this.opts.store }).upsertContainers(all);
    return all;
  }

  // No refresh starts for a connector whose delete is in progress. One that
  // started before is stopped by `retire`, which also waits for it: whatever
  // it was storing at that moment is in the store before the delete clears it.
  private refuseIfRetiring(connectorId: string): void {
    if (this.retiring.has(connectorId)) throw beingDeleted();
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
    // Its delete is in progress: nothing more is fetched for it.
    if (this.retiring.has(connectorId)) return;
    // Registered before the first wait below, so that a delete beginning
    // during any of them finds this run and stops it.
    const stop = new AbortController();
    this.inFlight.set(connectorId, stop);
    let result: KnowledgeRunResult;
    try {
      if (!(await this.opts.isAvailable())) {
        this.log(`knowledge sync for ${connectorId} skipped: the knowledge layer is unavailable`);
        return;
      }
      // Its delete began while the gate was being asked.
      if (stop.signal.aborted) return;
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
      // Anything that throws from here on is still a run an admin must be
      // able to see: record it as failed instead of leaving the history silent.
      try {
        await this.ensureLife(cfg);
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
          // Shutdown, or the delete of this connector.
          signal: AbortSignal.any([this.shutdown.signal, stop.signal]),
        });
        result = await harness.run(mode);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.failRun(connectorId, startedAt, startTime, message);
        return;
      }
    } finally {
      if (this.inFlight.get(connectorId) === stop) this.inFlight.delete(connectorId);
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
