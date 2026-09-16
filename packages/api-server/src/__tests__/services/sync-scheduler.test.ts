import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock bullmq ───────────────────────────────────────────────────────
// First BullMQ-mock test in api-server; the spy pattern is ported from
// packages/event-bus/src/__tests__/event-bus.test.ts. The Worker mock must
// provide `.on` (the scheduler attaches a 'failed' listener in its ctor).
const mockQueueAdd = vi.fn().mockResolvedValue(undefined);
const mockQueueClose = vi.fn().mockResolvedValue(undefined);
const mockQueueOn = vi.fn();
const mockWorkerOn = vi.fn();
const mockWorkerClose = vi.fn().mockResolvedValue(undefined);

let capturedProcessor:
  ((job: { data: unknown; log: (s: string) => void }) => Promise<void>) | null = null;

// Vitest 4 only treats `function`/`class` mock impls as constructable (`new`).
vi.mock('bullmq', () => {
  const Queue = vi.fn().mockImplementation(function () {
    return {
      add: mockQueueAdd,
      getRepeatableJobs: vi.fn().mockResolvedValue([]),
      removeRepeatableByKey: vi.fn().mockResolvedValue(undefined),
      on: mockQueueOn,
      close: mockQueueClose,
    };
  });
  const Worker = vi.fn().mockImplementation(function (
    _name: string,
    processor: (job: { data: unknown; log: (s: string) => void }) => Promise<void>,
  ) {
    capturedProcessor = processor;
    return { on: mockWorkerOn, close: mockWorkerClose };
  });
  return { Queue, Worker };
});

const fakeBuild = vi.fn();
vi.mock('../../services/connector-types/index.js', () => ({
  getConnectorType: (type: string) =>
    type === 'github'
      ? { type: 'github', pollMode: 'incremental', build: fakeBuild }
      : type === 'fullpoll'
        ? { type: 'fullpoll', pollMode: 'full', build: fakeBuild }
        : undefined,
  connectorTypeFor: (cfg: { type: string }) => ({
    type: cfg.type,
    pollMode: cfg.type === 'fullpoll' ? 'full' : 'incremental',
    build: fakeBuild,
  }),
}));

import { Queue } from 'bullmq';
import { SyncScheduler } from '../../services/sync-scheduler.js';
import { COMPLETED_JOB_RETENTION, FAILED_JOB_RETENTION } from '@shipit-ai/event-bus';

function makeScheduler(overrides: Partial<ConstructorParameters<typeof SyncScheduler>[0]> = {}) {
  return new SyncScheduler({
    redisUrl: 'redis://localhost:6379',
    registry: {
      get: vi.fn(),
      recordRun: vi.fn().mockResolvedValue(undefined),
      list: () => [],
    } as never,
    eventBus: {
      publish: vi.fn().mockResolvedValue(undefined),
      publishControl: vi.fn().mockResolvedValue(undefined),
    } as never,
    globalApp: { id: '', privateKeyPath: '' },
    ...overrides,
  });
}

function fakeConnector(warnings: string[] = []) {
  return {
    manifest: {
      name: 'fake',
      version: '1',
      schema_version: '1',
      min_sdk_version: '0',
      supported_entity_types: [],
    },
    authenticate: vi.fn().mockResolvedValue({ success: true }),
    discover: vi.fn().mockResolvedValue({ entity_types: [], total_entities: {} }),
    fetch: vi.fn(),
    normalize: vi.fn(),
    sync: vi.fn(),
    getWarnings: () => warnings,
  };
}

describe('SyncScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('constructs its queue with bounded retention (completed 24h/1k, failed 7d/5k)', () => {
    makeScheduler();
    const lastCall = vi.mocked(Queue).mock.calls.at(-1);
    expect(lastCall?.[0]).toBe('shipit-sync-github');
    expect(lastCall?.[1]).toMatchObject({
      defaultJobOptions: {
        removeOnComplete: COMPLETED_JOB_RETENTION,
        removeOnFail: FAILED_JOB_RETENTION,
      },
    });
  });

  it('attaches an error listener to both queue and worker so a Redis OOM/ReplyError degrades instead of crashing the process', () => {
    makeScheduler();

    // A BullMQ Worker/Queue is an EventEmitter; an emitted 'error' with NO
    // listener makes Node rethrow and kills the process — exactly the
    // crashloop the 2026-06-22 deploy hit when the worker's moveToActive Lua
    // eval failed with `OOM command not allowed`. A registered listener is the
    // fix.
    const queueErr = mockQueueOn.mock.calls.find(([evt]) => evt === 'error');
    const workerErr = mockWorkerOn.mock.calls.find(([evt]) => evt === 'error');
    expect(queueErr).toBeDefined();
    expect(workerErr).toBeDefined();

    // The handler must swallow (log) the error, never rethrow.
    const oom = new Error("OOM command not allowed when used memory > 'maxmemory'");
    expect(() => (queueErr?.[1] as (e: Error) => void)(oom)).not.toThrow();
    expect(() => (workerErr?.[1] as (e: Error) => void)(oom)).not.toThrow();
  });

  it('still enqueues a repeatable poll job on start()', async () => {
    const scheduler = makeScheduler();
    await scheduler.start({
      id: 'github-shipitops',
      type: 'github',
      enabled: true,
      schedule: '*/5 * * * *',
    } as never);

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'poll:github-shipitops',
      { connectorId: 'github-shipitops', mode: 'incremental' },
      { repeat: { pattern: '*/5 * * * *' } },
    );
  });
});

describe('SyncScheduler — connector types', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedProcessor = null;
  });

  it("enqueues the repeat job with the type's pollMode", async () => {
    const scheduler = makeScheduler();
    await scheduler.start({
      id: 'k',
      type: 'fullpoll',
      enabled: true,
      schedule: '*/5 * * * *',
    } as never);
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'poll:k',
      { connectorId: 'k', mode: 'full' },
      { repeat: { pattern: '*/5 * * * *' } },
    );
  });

  it('publishes sync.completed only after a successful FULL run', async () => {
    const registry = {
      get: vi.fn().mockReturnValue({ id: 'k', type: 'fullpoll' }),
      recordRun: vi.fn().mockResolvedValue(undefined),
      list: () => [],
    };
    const eventBus = {
      publish: vi.fn().mockResolvedValue(undefined),
      publishControl: vi.fn().mockResolvedValue(undefined),
    };
    makeScheduler({ registry: registry as never, eventBus: eventBus as never });
    fakeBuild.mockResolvedValue({
      ok: true,
      connector: fakeConnector(),
      sdkConfig: { id: 'k', type: 'fullpoll', credentials: {}, scope: {} },
    });

    await capturedProcessor!({ data: { connectorId: 'k', mode: 'full' }, log: () => undefined });
    expect(eventBus.publishControl).toHaveBeenCalledWith('k', {
      kind: 'sync.completed',
      startedAt: expect.stringMatching(/T/),
      mode: 'full',
    });
    expect(registry.recordRun).toHaveBeenCalledWith(
      'k',
      expect.objectContaining({ status: 'success' }),
    );

    eventBus.publishControl.mockClear();
    await capturedProcessor!({
      data: { connectorId: 'k', mode: 'incremental' },
      log: () => undefined,
    });
    expect(eventBus.publishControl).not.toHaveBeenCalled();
  });

  it('folds connector warnings into the run as partial and skips the sweep', async () => {
    const registry = {
      get: vi.fn().mockReturnValue({ id: 'k', type: 'fullpoll' }),
      recordRun: vi.fn().mockResolvedValue(undefined),
      list: () => [],
    };
    const eventBus = { publish: vi.fn(), publishControl: vi.fn() };
    const scheduler = makeScheduler({
      registry: registry as never,
      eventBus: eventBus as never,
    });
    fakeBuild.mockResolvedValue({
      ok: true,
      connector: fakeConnector(['FORBIDDEN:CronJob — denied']),
      sdkConfig: { id: 'k', type: 'fullpoll', credentials: {}, scope: {} },
    });

    await capturedProcessor!({ data: { connectorId: 'k', mode: 'full' }, log: () => undefined });
    expect(registry.recordRun).toHaveBeenCalledWith(
      'k',
      expect.objectContaining({ status: 'partial', errors: ['FORBIDDEN:CronJob — denied'] }),
    );
    expect(eventBus.publishControl).not.toHaveBeenCalled();
    expect(scheduler.getStatus('k')).toMatchObject({
      state: 'degraded',
      lastError: 'FORBIDDEN:CronJob — denied',
    });
  });

  it('records a build failure as a failed run without running the harness', async () => {
    const registry = {
      get: vi.fn().mockReturnValue({ id: 'gh', type: 'github' }),
      recordRun: vi.fn().mockResolvedValue(undefined),
      list: () => [],
    };
    const scheduler = makeScheduler({ registry: registry as never });
    fakeBuild.mockResolvedValue({
      ok: false,
      code: 'APP_NOT_CONFIGURED',
      message: 'No GitHub App configured.',
    });

    await capturedProcessor!({
      data: { connectorId: 'gh', mode: 'incremental' },
      log: () => undefined,
    });
    expect(registry.recordRun).toHaveBeenCalledWith(
      'gh',
      expect.objectContaining({ status: 'failed', errors: ['No GitHub App configured.'] }),
    );
    expect(scheduler.getStatus('gh')).toMatchObject({ state: 'failed' });
  });

  it('a sync.completed publish failure is logged, not thrown', async () => {
    const registry = {
      get: vi.fn().mockReturnValue({ id: 'k', type: 'fullpoll' }),
      recordRun: vi.fn().mockResolvedValue(undefined),
      list: () => [],
    };
    const eventBus = {
      publish: vi.fn(),
      publishControl: vi.fn().mockRejectedValue(new Error('OOM')),
    };
    makeScheduler({ registry: registry as never, eventBus: eventBus as never });
    fakeBuild.mockResolvedValue({
      ok: true,
      connector: fakeConnector(),
      sdkConfig: { id: 'k', type: 'fullpoll', credentials: {}, scope: {} },
    });
    const log = vi.fn();
    await expect(
      capturedProcessor!({ data: { connectorId: 'k', mode: 'full' }, log }),
    ).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('sync.completed'));
  });
});
