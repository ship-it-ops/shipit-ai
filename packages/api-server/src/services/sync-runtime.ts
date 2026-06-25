// Boot-time wiring for the BullMQ-backed sync runtime (scheduler + webhook
// refetch queue + event bus). Extracted from index.ts so the failure arm — the
// one that silently degrades connectors to "syncs never run" — is testable
// without standing up the whole server.
//
// The hazard this guards (scar bullmq-5-forbids-colons): if the scheduler's
// constructor throws (e.g. a `:` sneaks back into a queue name and `new Queue`
// throws synchronously), the boot code must NOT take the API down — but it also
// must not silently leave the registry on its NoopRunner with no signal, which
// presents to operators as connectors that accept config but never sync. This
// function keeps the API up AND returns `degraded: true` so the fallback is
// observable to the caller instead of being swallowed into one log line.
import { BullMQEventBusClient } from '@shipit-ai/event-bus';
import type { AppLike } from '@shipit-ai/shared';
import { SyncScheduler, type SyncSchedulerOptions } from './sync-scheduler.js';
import { WebhookRefetchQueue, type WebhookRefetchQueueOptions } from './webhook-refetch-queue.js';
import {
  AuditRetentionScheduler,
  type AuditRetentionSchedulerOptions,
} from './audit-retention-scheduler.js';
import type { AuditRetentionService } from './audit-retention-service.js';
import type { ConnectorRegistry } from './connector-registry.js';

export interface SyncRuntime {
  eventBus: BullMQEventBusClient | null;
  scheduler: SyncScheduler | null;
  webhookRefetch: WebhookRefetchQueue | null;
  // Daily GraphEditEvent audit-retention cleanup. null when no Redis is
  // configured, when wiring degraded, OR when retention is disabled
  // (auditRetentionDays = 0) — the caller never has to call start() on it.
  auditRetention: AuditRetentionScheduler | null;
  // True when a Redis URL WAS configured but wiring threw and we fell back to
  // the registry's NoopRunner. Distinguishes "intentionally no Redis"
  // (degraded: false, everything null) from "Redis configured but the
  // scheduler is silently dead" (degraded: true) — the case operators need to
  // see. `false` on the happy path and on the no-Redis path.
  degraded: boolean;
}

// Injection seams. Default to the real constructors; tests pass fakes — or a
// real constructor with a poisoned queue name — to exercise the failure arm
// without a live Redis.
export interface SyncRuntimeFactories {
  createEventBus?: (redisUrl: string) => BullMQEventBusClient;
  createScheduler?: (opts: SyncSchedulerOptions) => SyncScheduler;
  createWebhookRefetch?: (opts: WebhookRefetchQueueOptions) => WebhookRefetchQueue;
  createAuditRetention?: (opts: AuditRetentionSchedulerOptions) => AuditRetentionScheduler;
  // Defaults to the global console. Tests pass a capturing logger so the boot
  // warnings don't spam the test output and can be asserted on.
  logger?: Pick<typeof console, 'log' | 'warn'>;
}

export interface WireSyncRuntimeOptions {
  // Undefined / empty when no Redis is configured — syncs are disabled but CRUD
  // still works via the NoopRunner.
  redisUrl: string | undefined;
  registry: ConnectorRegistry;
  // LIVE REFERENCE — must be the same object GitHubAppService mutates on PUT
  // /github/app so the scheduler reads the latest credentials per job without a
  // restart. Do not spread/freeze it upstream. See
  // docs/agent/patterns/live-reference-for-hot-reload.md.
  globalApp: AppLike;
  concurrency: number;
  // The constructed audit-retention service (carries the configured window +
  // the Neo4j handle). When omitted or when its `enabled` is false, no
  // audit-retention scheduler is wired. Kept as the service (not raw config) so
  // wireSyncRuntime stays decoupled from Neo4jService construction.
  auditRetention?: AuditRetentionService;
  factories?: SyncRuntimeFactories;
}

export function wireSyncRuntime(opts: WireSyncRuntimeOptions): SyncRuntime {
  const { redisUrl, registry, globalApp, concurrency } = opts;
  const log = opts.factories?.logger ?? console;
  const createEventBus =
    opts.factories?.createEventBus ?? ((url) => new BullMQEventBusClient({ redisUrl: url }));
  const createScheduler = opts.factories?.createScheduler ?? ((o) => new SyncScheduler(o));
  const createWebhookRefetch =
    opts.factories?.createWebhookRefetch ?? ((o) => new WebhookRefetchQueue(o));
  const createAuditRetention =
    opts.factories?.createAuditRetention ?? ((o) => new AuditRetentionScheduler(o));

  if (!redisUrl) {
    log.warn(
      'No Redis URL configured — connectors will accept CRUD writes but syncs will not run. Set backend.redis.url to enable.',
    );
    return {
      eventBus: null,
      scheduler: null,
      webhookRefetch: null,
      auditRetention: null,
      degraded: false,
    };
  }

  // Track partially-constructed resources so a throw mid-wiring can release any
  // BullMQ workers/connections that already came up, rather than stranding them.
  let eventBus: BullMQEventBusClient | null = null;
  let scheduler: SyncScheduler | null = null;
  let webhookRefetch: WebhookRefetchQueue | null = null;
  let auditRetention: AuditRetentionScheduler | null = null;
  try {
    eventBus = createEventBus(redisUrl);
    scheduler = createScheduler({ redisUrl, registry, eventBus, globalApp, concurrency });
    webhookRefetch = createWebhookRefetch({ redisUrl, registry, eventBus, globalApp, concurrency });
    // Only stand up the audit-retention scheduler when retention is enabled
    // (auditRetentionDays > 0). A disabled deployment never constructs a queue
    // for work it would skip anyway.
    if (opts.auditRetention?.enabled) {
      auditRetention = createAuditRetention({ redisUrl, service: opts.auditRetention });
    }

    // Swap the registry's NoopRunner for the live scheduler only after every
    // resource constructed — so a failure above leaves the registry on its
    // NoopRunner (clean) instead of pointing at a half-initialized scheduler.
    registry.setRunner(scheduler);
    log.log('SyncScheduler attached to ConnectorRegistry');
    log.log('WebhookRefetchQueue attached');
    if (auditRetention) log.log('AuditRetentionScheduler attached');
    return { eventBus, scheduler, webhookRefetch, auditRetention, degraded: false };
  } catch (err) {
    // Don't let broken wiring take down the API. The registry keeps its
    // NoopRunner (CRUD works, syncs don't); `degraded: true` makes that
    // fallback observable instead of silent.
    log.warn(`SyncScheduler init failed (continuing with no-op runner): ${(err as Error).message}`);
    // Best-effort release of anything that constructed before the throw so a
    // partial init doesn't strand BullMQ workers connected to Redis.
    void scheduler?.close().catch(() => undefined);
    void webhookRefetch?.close().catch(() => undefined);
    void auditRetention?.close().catch(() => undefined);
    void eventBus?.close().catch(() => undefined);
    return {
      eventBus: null,
      scheduler: null,
      webhookRefetch: null,
      auditRetention: null,
      degraded: true,
    };
  }
}
