// Daily scheduler for the GraphEditEvent audit-retention cleanup.
//
// Mirrors SyncScheduler / WebhookRefetchQueue: one BullMQ Queue + Worker per
// process, bounded retention so the cleanup jobs themselves don't accumulate in
// Redis (2026-06-17 OOM incident), and 'error' listeners so a Redis OOM degrades
// (log, never rethrow) instead of crashlooping the API (2026-06-22 scar
// redis-memory-limit-below-dataset-oomkills). A single repeatable job fires the
// AuditRetentionService.cleanup() on a daily cron; the actual batched DETACH
// DELETE lives in that service so it is unit-testable without Redis.
//
// Skipped entirely when retention is disabled (service.enabled === false →
// auditRetentionDays = 0): start() never enqueues, so a disabled deployment runs
// no cleanup work at all.
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { COMPLETED_JOB_RETENTION, FAILED_JOB_RETENTION } from '@shipit-ai/event-bus';
import type { AuditRetentionService } from './audit-retention-service.js';

export interface AuditRetentionSchedulerOptions {
  redisUrl: string;
  service: AuditRetentionService;
  // Defaults to "shipit-audit-retention". BullMQ 5 forbids `:` in queue names
  // (it reserves the colon for `bull:<queue>:<key>`) — hyphenate only.
  queueName?: string;
  // Daily cron. Default 03:00 — off-peak, away from the connector poll cadence.
  schedule?: string;
}

const DEFAULT_QUEUE = 'shipit-audit-retention';
// 03:00 daily. Audit growth is slow; a daily sweep is ample to bound it.
const DEFAULT_SCHEDULE = '0 3 * * *';
const JOB_NAME = 'audit-retention-cleanup';

// Parse a redis:// URL into the host/port shape bullmq's ConnectionOptions
// expects (avoids handing bullmq an ioredis instance the type checker can't
// reconcile across hoisted versions). Same constraint as SyncScheduler.
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

export class AuditRetentionScheduler {
  private queue: Queue;
  private worker: Worker;
  private service: AuditRetentionService;
  private schedule: string;

  constructor(opts: AuditRetentionSchedulerOptions) {
    this.service = opts.service;
    this.schedule = opts.schedule ?? DEFAULT_SCHEDULE;

    const queueName = opts.queueName ?? DEFAULT_QUEUE;
    const connection = parseRedisUrl(opts.redisUrl);
    this.queue = new Queue(queueName, {
      connection,
      defaultJobOptions: {
        removeOnComplete: COMPLETED_JOB_RETENTION,
        removeOnFail: FAILED_JOB_RETENTION,
      },
    });
    this.worker = new Worker(queueName, async (job: Job) => this.processJob(job), {
      connection,
    });

    // Degrade on a Redis 'error' (e.g. worker moveToActive failing with `OOM
    // command not allowed` against a full Redis): log, never rethrow, keep the
    // API up. The next daily tick retries once Redis recovers.
    this.queue.on('error', (err: Error) => {
      console.warn(
        `AuditRetentionScheduler queue Redis error (cleanup degraded, API stays up): ${err.message}`,
      );
    });
    this.worker.on('error', (err: Error) => {
      console.warn(
        `AuditRetentionScheduler worker Redis error (cleanup degraded, API stays up): ${err.message}`,
      );
    });
    this.worker.on('failed', (_job: Job | undefined, err: Error) => {
      console.warn(`audit-retention cleanup job failed: ${err.message}`);
    });
  }

  /**
   * Register the repeatable daily cleanup job. No-op when retention is disabled
   * (auditRetentionDays = 0) — nothing is enqueued, so a disabled deployment
   * does zero cleanup work. Adding the same repeatable job again is a BullMQ
   * no-op as long as (jobName, repeat) match.
   */
  async start(): Promise<void> {
    if (!this.service.enabled) return;
    await this.queue.add(JOB_NAME, {}, { repeat: { pattern: this.schedule } });
  }

  // Releases the worker and queue so the API can exit cleanly on SIGTERM.
  // Idempotent; safe to call twice.
  async close(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
  }

  // ── Job processor ────────────────────────────────────────────────────
  // Runs the batched cleanup and logs a one-line summary (the observability the
  // S6 plan wanted). A throw here surfaces via the 'failed' listener and BullMQ
  // re-runs on the next tick.
  private async processJob(_job: Job): Promise<void> {
    const deleted = await this.service.cleanup();
    // Heartbeat on EVERY completed run (even a zero-delete sweep): this sweep is
    // the primary bound against unbounded GraphEditEvent growth (the 2026-06-17
    // OOM class), so a silently-stalled worker must be distinguishable from a
    // drained backlog — a missing daily line is itself the alert signal.
    console.log(
      `audit-retention: sweep complete, deleted ${deleted} GraphEditEvent node(s) past the retention window`,
    );
  }
}
