// BullMQ-backed runner that implements the registry's ConnectorRunner
// contract. One queue holds sync jobs across all GitHub connector instances;
// a single Worker drains it with bounded concurrency (configurable via
// connectors.github.rateLimits.maxConcurrentSyncs). The scheduler:
//
//   - Adds a repeating job per enabled connector (cron from the connector's
//     `schedule` field).
//   - Lets callers enqueue an immediate one-shot job via `triggerSync`.
//   - Constructs a fresh `GitHubConnector` + `ConnectorHarness` per job so
//     runs don't share state and a panicking run can't poison the next one.
//   - On finish, records the outcome back into the registry's YAML history
//     and updates the in-memory runtime status.
//
// Tests can skip this entirely by leaving the default NoopRunner in place.
import { readFileSync } from 'node:fs';
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { GitHubConnector, authenticateGitHubApp } from '@shipit-ai/connector-github';
import { ConnectorHarness } from '@shipit-ai/connector-sdk';
import {
  resolveAppCredentials,
  type AppLike,
  type EventBusClient,
  type GitHubConnectorConfig,
} from '@shipit-ai/shared';
import type {
  ConnectorRegistry,
  ConnectorRunner,
  SyncRuntimeStatus,
} from './connector-registry.js';

interface SyncJobData {
  connectorId: string;
  mode: 'full' | 'incremental';
}

export interface SyncSchedulerOptions {
  redisUrl: string;
  registry: ConnectorRegistry;
  eventBus: EventBusClient;
  // Global GitHub App fallback used when a connector instance doesn't
  // override `app.*`. Either field may be empty if no global App is
  // configured — in that case every connector must override or sync fails
  // with APP_NOT_CONFIGURED.
  globalApp: AppLike;
  concurrency?: number;
  // Where to attach. Defaults to "shipit:sync:github" so multi-instance
  // setups can override (e.g. per environment) without colliding.
  queueName?: string;
}

const DEFAULT_QUEUE = 'shipit:sync:github';

// Parse a redis:// URL into the host/port/password shape that bullmq's
// ConnectionOptions expects. Avoids handing bullmq an ioredis instance,
// which the type checker can't reconcile when pnpm hoists two versions of
// ioredis into the workspace.
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

export class SyncScheduler implements ConnectorRunner {
  private queue: Queue;
  private worker: Worker;
  private registry: ConnectorRegistry;
  private eventBus: EventBusClient;
  private globalApp: AppLike;
  // Private-key contents memoized by path. Each unique App (whether the
  // global one or a per-connector override) reads from disk exactly once
  // per process lifetime — matches the secretlint posture that key files
  // are env-time material, not hot-swappable from the API. Restart to
  // pick up rotations.
  private privateKeyCache = new Map<string, string>();
  private statuses = new Map<string, SyncRuntimeStatus>();

  constructor(opts: SyncSchedulerOptions) {
    this.registry = opts.registry;
    this.eventBus = opts.eventBus;
    this.globalApp = opts.globalApp;

    const queueName = opts.queueName ?? DEFAULT_QUEUE;
    const connection = parseRedisUrl(opts.redisUrl);
    this.queue = new Queue(queueName, { connection });
    this.worker = new Worker(
      queueName,
      async (job: Job) => this.processJob(job as Job<SyncJobData>),
      {
        connection,
        concurrency: opts.concurrency ?? 3,
      },
    );

    this.worker.on('failed', (job: Job | undefined, err: Error) => {
      // The job itself records the run on completion; this handler is the
      // fallback when the processor throws before doing so (e.g. auth blew
      // up reading the private key).
      const data = job?.data as SyncJobData | undefined;
      const id = data?.connectorId;
      if (id) {
        this.statuses.set(id, {
          connectorId: id,
          state: 'failed',
          lastError: err.message,
        });
      }
    });
  }

  async start(connector: GitHubConnectorConfig): Promise<void> {
    if (!connector.enabled) return;
    // Adding the same repeatable job again is a no-op in BullMQ as long as
    // (jobName, repeat) match — the job key is derived from the cron
    // string. Update flow (stop+start) covers schedule changes.
    await this.queue.add(
      `poll:${connector.id}`,
      { connectorId: connector.id, mode: 'incremental' },
      { repeat: { pattern: connector.schedule } },
    );
    if (!this.statuses.has(connector.id)) {
      this.statuses.set(connector.id, { connectorId: connector.id, state: 'idle' });
    }
  }

  async stop(connectorId: string): Promise<void> {
    // Remove repeating definitions whose data matches this connector. BullMQ
    // doesn't index by data so we iterate — acceptable because the
    // repeatable set is bounded by the number of connectors.
    const repeats = await this.queue.getRepeatableJobs();
    for (const r of repeats) {
      if (r.name === `poll:${connectorId}`) {
        await this.queue.removeRepeatableByKey(r.key);
      }
    }
    this.statuses.delete(connectorId);
  }

  async triggerSync(
    connector: GitHubConnectorConfig,
    mode: 'full' | 'incremental',
  ): Promise<SyncRuntimeStatus> {
    await this.queue.add(`manual:${connector.id}`, {
      connectorId: connector.id,
      mode,
    });
    const status: SyncRuntimeStatus = {
      connectorId: connector.id,
      state: 'running',
      startedAt: new Date().toISOString(),
    };
    this.statuses.set(connector.id, status);
    return status;
  }

  getStatus(connectorId: string): SyncRuntimeStatus {
    return this.statuses.get(connectorId) ?? { connectorId, state: 'idle' };
  }

  // Releases the worker and queue so the API server can exit cleanly on
  // SIGTERM. Idempotent; safe to call twice.
  async close(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
  }

  // Memoize PEM contents per path so a connector that uses the global App
  // doesn't re-read the same file on every poll tick. Per-connector
  // override paths get their own cache slot — no key material crosses
  // between Apps even though they live in one Map.
  private readPrivateKey(path: string): string {
    const cached = this.privateKeyCache.get(path);
    if (cached !== undefined) return cached;
    const contents = readFileSync(path, 'utf-8');
    this.privateKeyCache.set(path, contents);
    return contents;
  }

  // ── Job processor ────────────────────────────────────────────────────
  // Constructs a per-job connector + harness, runs the sync, and writes
  // back. Anything that throws here is captured into the run record so a
  // single failed sync doesn't leak as a worker-level "failed" event when
  // the cause is recoverable (e.g. a transient 5xx from GitHub).
  private async processJob(job: Job<SyncJobData>): Promise<void> {
    const startTime = Date.now();
    const { connectorId, mode } = job.data;
    let cfg: GitHubConnectorConfig;
    try {
      cfg = this.registry.get(connectorId) as GitHubConnectorConfig;
    } catch (err) {
      // Connector was deleted while a job was still queued — drop the run
      // silently. Recording status would resurrect a no-longer-extant id.
      job.log(`connector ${connectorId} no longer exists: ${(err as Error).message}`);
      return;
    }

    this.statuses.set(connectorId, {
      connectorId,
      state: 'running',
      startedAt: new Date(startTime).toISOString(),
    });

    // Resolve which App identity backs this run. Per-connector override
    // wins over the global App; absence of both surfaces as a structured
    // failure (no auth attempt, no misleading 401 from GitHub).
    const resolved = resolveAppCredentials(cfg, this.globalApp);
    if (!resolved.id || !resolved.privateKeyPath) {
      const message = resolved.overridden
        ? `Connector ${connectorId} overrides the GitHub App but is missing app.id or app.privateKeyPath.`
        : `No GitHub App configured. Set GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY_PATH or set connector.app on each instance.`;
      await this.registry.recordRun(connectorId, {
        startedAt: new Date(startTime).toISOString(),
        durationMs: Date.now() - startTime,
        status: 'failed',
        entitiesSynced: 0,
        errors: [message],
      });
      this.statuses.set(connectorId, {
        connectorId,
        state: 'failed',
        startedAt: new Date(startTime).toISOString(),
        lastError: message,
      });
      return;
    }

    let privateKey: string;
    try {
      privateKey = this.readPrivateKey(resolved.privateKeyPath);
    } catch (err) {
      const message = `Cannot read App private key at ${resolved.privateKeyPath}: ${(err as Error).message}`;
      await this.registry.recordRun(connectorId, {
        startedAt: new Date(startTime).toISOString(),
        durationMs: Date.now() - startTime,
        status: 'failed',
        entitiesSynced: 0,
        errors: [message],
      });
      this.statuses.set(connectorId, {
        connectorId,
        state: 'failed',
        startedAt: new Date(startTime).toISOString(),
        lastError: message,
      });
      return;
    }

    // The connector SDK expects credentials shape with appId / privateKey
    // strings. We resolve from the cached file contents + the registry's
    // per-instance installationId so each org is bound to its own
    // installation.
    const connector = new GitHubConnector();
    const sdkConfig = {
      id: cfg.id,
      type: 'github',
      credentials: {
        appId: resolved.id,
        privateKey,
        installationId: cfg.installationId,
      },
      scope: { org: cfg.org },
    };

    const harness = new ConnectorHarness(connector, this.eventBus, sdkConfig);
    const result = await harness.runSync(mode);

    // Persist the outcome to the registry's history (cap 20). Best-effort —
    // a write failure shouldn't take down the worker.
    try {
      await this.registry.recordRun(connectorId, {
        startedAt: new Date(startTime).toISOString(),
        durationMs: result.duration_ms,
        status: result.status,
        entitiesSynced: result.entities_synced,
        errors: result.errors,
      });
    } catch (err) {
      job.log(`failed to persist run history: ${(err as Error).message}`);
    }

    // 401/403 are sticky — surface as "degraded" so the UI flags the
    // connector instead of letting the next polling tick repeat the
    // failure silently. Auth.success === false manifests as a single error
    // string in result.errors when GitHubConnector.authenticate fails.
    const authFailed = result.errors.some(
      (e) =>
        e.toLowerCase().includes('auth failed') ||
        e.toLowerCase().includes('unauthorized') ||
        e.toLowerCase().includes('forbidden'),
    );

    this.statuses.set(connectorId, {
      connectorId,
      startedAt: new Date(startTime).toISOString(),
      state:
        result.status === 'success'
          ? 'idle'
          : authFailed
            ? 'degraded'
            : result.status === 'partial'
              ? 'degraded'
              : 'failed',
      lastError: result.errors[0],
    });
  }
}

// Best-effort smoke probe — confirms the configured GitHub App credentials
// are usable, without enqueuing anything. Useful at boot to fail-fast if the
// App ID/key pair is busted.
export async function probeAppCredentials(
  appId: string,
  privateKeyPath: string,
  anyInstallationId: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const pk = readFileSync(privateKeyPath, 'utf-8');
    const { auth } = await authenticateGitHubApp({
      appId,
      privateKey: pk,
      installationId: anyInstallationId,
    });
    return { ok: auth.success, error: auth.error };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}
