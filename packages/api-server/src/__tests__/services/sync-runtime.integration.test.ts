/**
 * REAL-Redis/BullMQ integration test for wireSyncRuntime (#3, integration-test
 * roadmap).
 *
 * The unit suite (sync-runtime.test.ts) proves the wiring logic with fakes. What
 * it CAN'T prove is the thing that actually bit us: a real `new Queue(name)`
 * with a colon throws SYNCHRONOUSLY (the BullMQ-5 colon scar) — a mock would
 * happily accept the bad name. This drives wireSyncRuntime against real BullMQ:
 *  - a real scheduler construction with a colon queue name really throws, and
 *    wireSyncRuntime catches it → degraded, registry stays on the NoopRunner
 *    (the "syncs silently never run" boot degradation #3 targets);
 *  - the happy path really stands up the scheduler + webhook queue + event bus
 *    against Redis and a triggered sync really enqueues onto the live scheduler.
 *
 * Gated on REDIS_TEST_URL (skips by default → unit `pnpm test` stays Docker-
 * free). Run locally with a THROWAWAY redis on a non-default port so your real
 * docker-redis-1 is never touched:
 *   docker run -d --name shipit-itest-redis -p 6380:6379 redis:7
 *   REDIS_TEST_URL=redis://localhost:6380 pnpm --filter @shipit-ai/api-server run test:integration
 *
 * Isolation: unique hyphenated queue names per run (itest-<pid>-<perf>) so
 * parallel/repeat runs never collide; every runtime constructed is closed in
 * afterEach.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectorInstanceConfig } from '@shipit-ai/shared';
import { ConnectorRegistry } from '../../services/connector-registry.js';
import { SyncScheduler } from '../../services/sync-scheduler.js';
import { WebhookRefetchQueue } from '../../services/webhook-refetch-queue.js';
import { wireSyncRuntime, type SyncRuntime } from '../../services/sync-runtime.js';

const REDIS = process.env.REDIS_TEST_URL;
const RUN = `itest-${process.pid}-${Math.floor(performance.now())}`;

const CONNECTOR = {
  id: 'github-acme',
  type: 'github',
  name: 'Acme',
  enabled: true,
} as unknown as ConnectorInstanceConfig;

function makeRegistry(): ConnectorRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'shipit-syncruntime-it-'));
  return new ConnectorRegistry({
    localConfigPath: join(dir, 'shipit.config.local.yaml'),
    initial: [CONNECTOR],
  });
}

const GLOBAL_APP = { appId: '', privateKey: '' } as never;

describe.skipIf(!REDIS)('wireSyncRuntime — real Redis/BullMQ integration', () => {
  const runtimes: SyncRuntime[] = [];
  let q = 0;

  afterEach(async () => {
    for (const rt of runtimes.splice(0)) {
      await rt.scheduler?.close().catch(() => undefined);
      await rt.webhookRefetch?.close().catch(() => undefined);
      await rt.eventBus?.close().catch(() => undefined);
    }
  });

  it('stands up the live scheduler against real Redis and routes a sync to it', async () => {
    const registry = makeRegistry();
    const suffix = q++;
    const runtime = wireSyncRuntime({
      redisUrl: REDIS,
      registry,
      globalApp: GLOBAL_APP,
      concurrency: 1,
      // Real constructors, unique hyphenated queue names for isolation.
      factories: {
        createScheduler: (o) => new SyncScheduler({ ...o, queueName: `${RUN}-sync-${suffix}` }),
        createWebhookRefetch: (o) =>
          new WebhookRefetchQueue({ ...o, queueName: `${RUN}-wh-${suffix}` }),
        logger: { log: () => undefined, warn: () => undefined },
      },
    });
    runtimes.push(runtime);

    expect(runtime.degraded).toBe(false);
    expect(runtime.scheduler).toBeInstanceOf(SyncScheduler);
    expect(runtime.eventBus).not.toBeNull();

    // A sync triggered through the registry really enqueues onto the live
    // scheduler's BullMQ queue (real queue.add, no throw) and the scheduler
    // reports it running — proof the NoopRunner was actually replaced.
    const status = await registry.triggerSync(CONNECTOR.id, 'incremental');
    expect(status.state).toBe('running');
    expect(registry.getStatus(CONNECTOR.id).state).toBe('running');
  });

  it('catches the REAL colon-queue-name throw and degrades to the NoopRunner', async () => {
    const registry = makeRegistry();
    let warned = '';

    const runtime = wireSyncRuntime({
      redisUrl: REDIS,
      registry,
      globalApp: GLOBAL_APP,
      concurrency: 1,
      factories: {
        // Real SyncScheduler with a colon-laden queue name → real BullMQ
        // `new Queue(...)` throws synchronously (the colon scar). A mock would
        // not.
        createScheduler: (o) => new SyncScheduler({ ...o, queueName: 'shipit:sync:github' }),
        logger: { log: () => undefined, warn: (m) => (warned = String(m)) },
      },
    });
    runtimes.push(runtime);

    // API survived a real construction throw.
    expect(runtime.degraded).toBe(true);
    expect(runtime.scheduler).toBeNull();
    expect(warned).toContain('SyncScheduler init failed');

    // Registry stayed on the inert NoopRunner: the sync reports idle and never
    // ran — the silent-degradation symptom, now asserted against real BullMQ.
    const status = await registry.triggerSync(CONNECTOR.id, 'incremental');
    expect(status.state).toBe('idle');
  });
});
