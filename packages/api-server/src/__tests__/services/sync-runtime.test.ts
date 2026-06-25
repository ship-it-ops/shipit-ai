/**
 * Unit tests for wireSyncRuntime (#3, integration-test roadmap).
 *
 * The hazard: if scheduler/queue construction throws at boot (the colon-in-
 * queue-name scar), the API must stay up — but the registry must NOT silently
 * keep its NoopRunner with no signal, because that presents as connectors that
 * accept config yet never sync ("stuck" forever). These tests pin both halves:
 * the API survives a construction throw, AND the degradation is observable
 * (`degraded: true` + a warning) rather than swallowed.
 *
 * Behavior is observed through a REAL ConnectorRegistry: we trigger a sync and
 * assert whether it routes to the live (fake) scheduler or stays on the inert
 * NoopRunner — i.e. the actual user-visible consequence, not the wiring's
 * internals. Injected fakes stand in for the BullMQ-backed resources so no
 * Redis is needed; the real-Queue colon throw is covered in the sibling
 * integration test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnectorInstanceConfig } from '@shipit-ai/shared';
import { ConnectorRegistry } from '../../services/connector-registry.js';
import {
  wireSyncRuntime,
  type SyncRuntimeFactories,
  type WireSyncRuntimeOptions,
} from '../../services/sync-runtime.js';

const CONNECTOR = {
  id: 'github-acme',
  type: 'github',
  name: 'Acme',
  enabled: true,
} as unknown as ConnectorInstanceConfig;

function makeRegistry(): ConnectorRegistry {
  const dir = mkdtempSync(join(tmpdir(), 'shipit-syncruntime-'));
  return new ConnectorRegistry({
    localConfigPath: join(dir, 'shipit.config.local.yaml'),
    initial: [CONNECTOR],
  });
}

// A fake that satisfies both the ConnectorRunner contract (so setRunner
// accepts it) and the close() the cleanup path calls.
function fakeScheduler() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    triggerSync: vi.fn().mockResolvedValue({ connectorId: CONNECTOR.id, state: 'running' }),
    getStatus: vi.fn().mockReturnValue({ connectorId: CONNECTOR.id, state: 'idle' }),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function captureLogger() {
  return { log: vi.fn(), warn: vi.fn() };
}

function baseOpts(
  registry: ConnectorRegistry,
  factories: SyncRuntimeFactories,
): WireSyncRuntimeOptions {
  return {
    redisUrl: 'redis://localhost:6379',
    registry,
    globalApp: { appId: '', privateKey: '' } as never,
    concurrency: 3,
    factories,
  };
}

describe('wireSyncRuntime', () => {
  beforeEach(() => vi.clearAllMocks());

  it('attaches the live scheduler so a triggered sync routes to it (happy path)', async () => {
    const registry = makeRegistry();
    const scheduler = fakeScheduler();
    const logger = captureLogger();

    const runtime = wireSyncRuntime(
      baseOpts(registry, {
        createEventBus: () => ({ close: vi.fn() }) as never,
        createScheduler: () => scheduler as never,
        createWebhookRefetch: () => ({ close: vi.fn() }) as never,
        logger,
      }),
    );

    expect(runtime.degraded).toBe(false);
    expect(runtime.scheduler).toBe(scheduler);
    // The user-visible proof of attachment: a sync goes through the scheduler.
    await registry.triggerSync(CONNECTOR.id);
    expect(scheduler.triggerSync).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('keeps the API up AND reports degraded when scheduler construction throws', async () => {
    const registry = makeRegistry();
    const logger = captureLogger();
    const eventBusClose = vi.fn().mockResolvedValue(undefined);

    const runtime = wireSyncRuntime(
      baseOpts(registry, {
        createEventBus: () => ({ close: eventBusClose }) as never,
        createScheduler: () => {
          throw new Error('Queue name cannot contain :'); // the colon scar, synchronously
        },
        logger,
      }),
    );

    // Did not throw — the API survives.
    expect(runtime.degraded).toBe(true);
    expect(runtime.scheduler).toBeNull();
    expect(runtime.eventBus).toBeNull();
    // Loud, not silent.
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('SyncScheduler init failed'));
    // The registry stayed on its inert NoopRunner: a triggered sync reports
    // idle and enqueues nothing (the silent-degradation symptom, now asserted).
    const status = await registry.triggerSync(CONNECTOR.id);
    expect(status.state).toBe('idle');
    // The event bus that DID construct before the throw is released.
    expect(eventBusClose).toHaveBeenCalledTimes(1);
  });

  it('does not swap the runner and cleans up when a LATER resource throws (partial init)', async () => {
    const registry = makeRegistry();
    const scheduler = fakeScheduler();
    const eventBusClose = vi.fn().mockResolvedValue(undefined);

    const runtime = wireSyncRuntime(
      baseOpts(registry, {
        createEventBus: () => ({ close: eventBusClose }) as never,
        createScheduler: () => scheduler as never,
        createWebhookRefetch: () => {
          throw new Error('webhook queue boom');
        },
        logger: captureLogger(),
      }),
    );

    expect(runtime.degraded).toBe(true);
    // Registry must NOT be left pointing at the scheduler when wiring failed
    // afterwards — a triggered sync stays on the NoopRunner.
    const status = await registry.triggerSync(CONNECTOR.id);
    expect(status.state).toBe('idle');
    expect(scheduler.triggerSync).not.toHaveBeenCalled();
    // Both resources that constructed before the throw are released.
    expect(scheduler.close).toHaveBeenCalledTimes(1);
    expect(eventBusClose).toHaveBeenCalledTimes(1);
  });

  it('disables syncs without degrading when no Redis URL is configured', async () => {
    const registry = makeRegistry();
    const logger = captureLogger();
    const createScheduler = vi.fn();

    const runtime = wireSyncRuntime({
      redisUrl: undefined,
      registry,
      globalApp: { appId: '', privateKey: '' } as never,
      concurrency: 3,
      factories: { createScheduler: createScheduler as never, logger },
    });

    expect(runtime).toEqual({
      eventBus: null,
      scheduler: null,
      webhookRefetch: null,
      auditRetention: null,
      degraded: false, // intentional, not a failure
    });
    expect(createScheduler).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('No Redis URL configured'));
  });

  it('wires the audit-retention scheduler when retention is enabled', async () => {
    const registry = makeRegistry();
    const auditScheduler = { close: vi.fn() };
    const createAuditRetention = vi.fn().mockReturnValue(auditScheduler);

    const runtime = wireSyncRuntime({
      ...baseOpts(registry, {
        createEventBus: () => ({ close: vi.fn() }) as never,
        createScheduler: () => fakeScheduler() as never,
        createWebhookRefetch: () => ({ close: vi.fn() }) as never,
        createAuditRetention: createAuditRetention as never,
        logger: captureLogger(),
      }),
      auditRetention: { enabled: true } as never,
    });

    expect(createAuditRetention).toHaveBeenCalledTimes(1);
    expect(runtime.auditRetention).toBe(auditScheduler);
  });

  it('skips the audit-retention scheduler when retention is disabled', async () => {
    const registry = makeRegistry();
    const createAuditRetention = vi.fn();

    const runtime = wireSyncRuntime({
      ...baseOpts(registry, {
        createEventBus: () => ({ close: vi.fn() }) as never,
        createScheduler: () => fakeScheduler() as never,
        createWebhookRefetch: () => ({ close: vi.fn() }) as never,
        createAuditRetention: createAuditRetention as never,
        logger: captureLogger(),
      }),
      auditRetention: { enabled: false } as never,
    });

    expect(createAuditRetention).not.toHaveBeenCalled();
    expect(runtime.auditRetention).toBeNull();
  });
});
