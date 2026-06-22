// Coalesced, async refetch worker for the GitHub webhook receiver (T7).
//
// A verified webhook delivery doesn't translate the payload directly; it
// enqueues a debounced job that REFETCHES just the affected entity through the
// connector's existing normalizers, so downstream stays source-agnostic and
// identical to the polling path. Modeled on SyncScheduler:
//
//   - One BullMQ Queue + Worker per process, bounded concurrency, retention
//     defaults so completed/failed jobs don't accumulate in Redis (2026-06-17
//     OOM incident).
//   - Per-App private keys memoized by path (env-time material; restart to
//     rotate).
//
// Coalescing: a burst of identical deliveries (GitHub redelivers aggressively)
// collapses to ONE job via a deterministic jobId + a short delay — BullMQ
// ignores `add` for a jobId already present/waiting.
//
// Delivery dedup: a Redis SETNX short-TTL key stops a captured signed delivery
// from being replayed forever into unbounded GitHub calls. This is separate
// from job coalescing (which only collapses same-entity refetches).
//
// Durability: if eventBus.publish REJECTS (Redis down/OOM), the error
// propagates so the BullMQ job fails and retries — we never swallow it.
import { readFileSync } from 'node:fs';
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { GitHubConnector } from '@shipit-ai/connector-github';
import { COMPLETED_JOB_RETENTION, FAILED_JOB_RETENTION } from '@shipit-ai/event-bus';
import {
  resolveAppCredentials,
  type AppLike,
  type EventBusClient,
  type GitHubConnectorConfig,
} from '@shipit-ai/shared';
import type { ConnectorRegistry } from './connector-registry.js';

export type RefetchKind = 'repo' | 'workflows';

export interface WebhookRefetchJob {
  connectorId: string;
  owner: string;
  repo: string;
  kind: RefetchKind;
}

export interface WebhookRefetchQueueOptions {
  redisUrl: string;
  registry: ConnectorRegistry;
  eventBus: EventBusClient;
  // Global GitHub App fallback used when a connector instance doesn't
  // override `app.*`. Live reference — see SyncScheduler.
  globalApp: AppLike;
  concurrency?: number;
  // Defaults to "shipit-webhook-refetch". BullMQ 5 forbids `:` in queue names
  // (it reserves the colon for `bull:<queue>:<key>`) — hyphenate only.
  queueName?: string;
}

const DEFAULT_QUEUE = 'shipit-webhook-refetch';
// Debounce window. A short delay lets a burst of identical deliveries collapse
// onto one waiting job before the worker picks it up.
const COALESCE_DELAY_MS = 1500;
// Delivery-dedup key TTL. Long enough to absorb GitHub's redelivery window,
// short enough that the keyspace stays bounded.
const DELIVERY_TTL_SECONDS = 600;

// Parse a redis:// URL into the host/port/password shape bullmq's
// ConnectionOptions expects (avoids handing bullmq an ioredis instance the
// type checker can't reconcile across hoisted versions). Copied from
// SyncScheduler intentionally — same constraint.
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

// BullMQ 5 forbids `:` in job ids too (same colon scar as queue names). Replace
// any colon in caller-supplied identifiers with `~`.
function sanitizeIdPart(part: string): string {
  return part.replace(/:/g, '~');
}

export class WebhookRefetchQueue {
  private queue: Queue;
  private worker: Worker;
  private redis: Redis;
  private registry: ConnectorRegistry;
  private eventBus: EventBusClient;
  private globalApp: AppLike;
  // PEM contents memoized by path — same posture as SyncScheduler: key files
  // are env-time material, read once per process; restart to pick up rotations.
  private privateKeyCache = new Map<string, string>();

  constructor(opts: WebhookRefetchQueueOptions) {
    this.registry = opts.registry;
    this.eventBus = opts.eventBus;
    this.globalApp = opts.globalApp;

    const queueName = opts.queueName ?? DEFAULT_QUEUE;
    const connection = parseRedisUrl(opts.redisUrl);
    // A dedicated ioredis client for the SETNX delivery-dedup keys. Separate
    // from the BullMQ connections so closing the queue doesn't strand it (and
    // vice versa).
    this.redis = new Redis(opts.redisUrl, { maxRetriesPerRequest: null });

    this.queue = new Queue(queueName, {
      connection,
      defaultJobOptions: {
        removeOnComplete: COMPLETED_JOB_RETENTION,
        removeOnFail: FAILED_JOB_RETENTION,
      },
    });
    this.worker = new Worker(
      queueName,
      async (job: Job) => this.processJob(job as Job<WebhookRefetchJob>),
      {
        connection,
        concurrency: opts.concurrency ?? 3,
      },
    );

    // Attach 'error' listeners to every emitter the queue owns (BullMQ Queue +
    // Worker + the dedup ioredis client). Without a listener, an emitted
    // 'error' — e.g. the worker's `moveToActive` failing with `OOM command not
    // allowed` against a full Redis — rethrows as an uncaughtException and
    // crashes the process (the 2026-06-22 deploy crashloop; scar
    // redis-memory-limit-below-dataset-oomkills). Degrade: log, never rethrow.
    this.queue.on('error', (err: Error) => {
      console.warn(
        `WebhookRefetchQueue queue Redis error (refetch degraded, API stays up): ${err.message}`,
      );
    });
    this.worker.on('error', (err: Error) => {
      console.warn(
        `WebhookRefetchQueue worker Redis error (refetch degraded, API stays up): ${err.message}`,
      );
    });
    this.redis.on('error', (err: Error) => {
      console.warn(
        `WebhookRefetchQueue dedup-redis error (refetch degraded, API stays up): ${err.message}`,
      );
    });

    this.worker.on('failed', (job: Job | undefined, err: Error) => {
      // The processor lets transient failures (auth, publish to a down event
      // bus) throw so BullMQ retries; this surfaces them in logs. Console is
      // intentional — the queue isn't bound to a Fastify logger.
      const data = job?.data as WebhookRefetchJob | undefined;
      console.warn(
        `webhook-refetch job failed (connector=${data?.connectorId} ${data?.owner}/${data?.repo} kind=${data?.kind}): ${err.message}`,
      );
    });
  }

  // Coalesced enqueue. The deterministic jobId means a burst of identical
  // deliveries for the same entity+kind collapses to one waiting job. The
  // small delay widens the coalescing window.
  async enqueue(job: WebhookRefetchJob): Promise<void> {
    const jobId = [job.connectorId, job.owner, job.repo, job.kind].map(sanitizeIdPart).join('~');
    await this.queue.add('refetch', job, { jobId, delay: COALESCE_DELAY_MS });
  }

  // Returns true when the delivery id is NEW (key was absent). A SET ... NX
  // succeeds only when the key didn't exist, so a redelivery of the same
  // X-GitHub-Delivery returns false and the caller skips the refetch.
  async markDeliverySeen(deliveryId: string): Promise<boolean> {
    const key = `wh~delivery~${sanitizeIdPart(deliveryId)}`;
    const result = await this.redis.set(key, '1', 'EX', DELIVERY_TTL_SECONDS, 'NX');
    return result === 'OK';
  }

  // Release a delivery's dedup key so a redelivery is processed rather than
  // swallowed as a duplicate. The receiver calls this when post-verify
  // processing (e.g. enqueue) fails AFTER the delivery was marked seen — without
  // it, GitHub's redelivery would dedup against the still-set key and the
  // refetch would be lost.
  async releaseDelivery(deliveryId: string): Promise<void> {
    const key = `wh~delivery~${sanitizeIdPart(deliveryId)}`;
    await this.redis.del(key);
  }

  // Record the most recent VERIFIED delivery for a connector. Stored on the
  // dedup redis client under a per-connector key with NO TTL (it's a "latest"
  // marker the admin settings view reads back, not a transient dedup key). The
  // receiver calls this best-effort post-verify.
  async recordVerifiedDelivery(rec: {
    connectorId: string;
    event: string;
    deliveryId: string;
    ts: string;
  }): Promise<void> {
    const key = `wh~lastverified~${sanitizeIdPart(rec.connectorId)}`;
    await this.redis.set(key, JSON.stringify(rec));
  }

  // Read back the last verified delivery for a connector. Returns null when
  // none has been recorded or the stored value is unparseable.
  async getLastVerifiedDelivery(
    connectorId: string,
  ): Promise<{ event: string; deliveryId: string; ts: string } | null> {
    const key = `wh~lastverified~${sanitizeIdPart(connectorId)}`;
    const raw = await this.redis.get(key);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as { event: string; deliveryId: string; ts: string };
      return { event: parsed.event, deliveryId: parsed.deliveryId, ts: parsed.ts };
    } catch {
      return null;
    }
  }

  // Release worker, queue, and the dedup redis client so the API exits cleanly
  // on SIGTERM. Idempotent.
  async close(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
    this.redis.disconnect();
  }

  private readPrivateKey(path: string): string {
    const cached = this.privateKeyCache.get(path);
    if (cached !== undefined) return cached;
    const contents = readFileSync(path, 'utf-8');
    this.privateKeyCache.set(path, contents);
    return contents;
  }

  // ── Job processor ──────────────────────────────────────────────────────
  // Resolve the connector's App credentials, authenticate a fresh
  // GitHubConnector, refetch the targeted entity, and publish it. Anything
  // that throws here (auth failure, publish rejection) propagates so BullMQ
  // retries — the durability path. The publish rejection in particular MUST
  // NOT be swallowed (2026-06-17 Redis-OOM scar).
  private async processJob(job: Job<WebhookRefetchJob>): Promise<void> {
    const { connectorId, owner, repo, kind } = job.data;

    let cfg: GitHubConnectorConfig;
    try {
      cfg = this.registry.get(connectorId) as GitHubConnectorConfig;
    } catch (err) {
      // Connector deleted while the job was queued — drop silently.
      job.log(`connector ${connectorId} no longer exists: ${(err as Error).message}`);
      return;
    }

    const resolved = resolveAppCredentials(cfg, this.globalApp);
    if (!resolved.id || !resolved.privateKeyPath) {
      throw new Error(
        `Cannot refetch for connector ${connectorId}: no resolvable GitHub App credentials.`,
      );
    }

    const privateKey = this.readPrivateKey(resolved.privateKeyPath);

    // Fresh connector per job so a panicking run can't poison the next one.
    // authenticate() mints the installation token, verifies it (getInstallation),
    // and sets the connector's internal octokit + org; the refetch helpers reuse
    // both with the same normalize() the poller uses. A single auth round-trip —
    // a separate fail-fast pre-check would just duplicate this call.
    const connector = new GitHubConnector();
    const authResult = await connector.authenticate({
      id: cfg.id,
      type: 'github',
      credentials: { appId: resolved.id, privateKey, installationId: cfg.installationId },
      scope: { org: owner },
    });
    if (!authResult.success) {
      throw new Error(`GitHub App auth failed for connector ${connectorId}: ${authResult.error}`);
    }

    const entity =
      kind === 'repo'
        ? await connector.refetchRepository(owner, repo)
        : await connector.refetchRepositoryWorkflows(owner, repo);

    // Let a publish rejection (event bus down/OOM) propagate so the job fails
    // and BullMQ retries — polling is the documented max-lag backstop.
    await this.eventBus.publish([entity], connectorId);
  }
}
