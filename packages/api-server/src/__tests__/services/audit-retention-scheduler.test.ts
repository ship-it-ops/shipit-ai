import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock bullmq ───────────────────────────────────────────────────────
// Same spy pattern as sync-scheduler.test.ts. The Worker mock captures the
// processor so we can drive a job through it directly, and provides `.on` (the
// scheduler attaches 'error'/'failed' listeners in its ctor).
const mockQueueAdd = vi.fn().mockResolvedValue(undefined);
const mockQueueClose = vi.fn().mockResolvedValue(undefined);
const mockQueueOn = vi.fn();
const mockWorkerOn = vi.fn();
const mockWorkerClose = vi.fn().mockResolvedValue(undefined);
let capturedProcessor: ((job: unknown) => Promise<unknown>) | undefined;

vi.mock('bullmq', () => {
  const Queue = vi.fn().mockImplementation(() => ({
    add: mockQueueAdd,
    getRepeatableJobs: vi.fn().mockResolvedValue([]),
    removeRepeatableByKey: vi.fn().mockResolvedValue(undefined),
    on: mockQueueOn,
    close: mockQueueClose,
  }));
  const Worker = vi
    .fn()
    .mockImplementation((_name: string, processor: typeof capturedProcessor) => {
      capturedProcessor = processor;
      return { on: mockWorkerOn, close: mockWorkerClose };
    });
  return { Queue, Worker };
});

import { Queue } from 'bullmq';
import { AuditRetentionScheduler } from '../../services/audit-retention-scheduler.js';
import type { AuditRetentionService } from '../../services/audit-retention-service.js';
import { COMPLETED_JOB_RETENTION, FAILED_JOB_RETENTION } from '@shipit-ai/event-bus';

function makeScheduler(cleanup = vi.fn().mockResolvedValue(0)) {
  const service = { enabled: true, cleanup } as unknown as AuditRetentionService;
  const scheduler = new AuditRetentionScheduler({
    redisUrl: 'redis://localhost:6379',
    service,
  });
  return { scheduler, cleanup };
}

describe('AuditRetentionScheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedProcessor = undefined;
  });

  it('constructs its queue with bounded retention so cleanup jobs do not accumulate in Redis', () => {
    makeScheduler();
    const lastCall = vi.mocked(Queue).mock.calls.at(-1);
    expect(lastCall?.[0]).toBe('shipit-audit-retention');
    expect(lastCall?.[1]).toMatchObject({
      defaultJobOptions: {
        removeOnComplete: COMPLETED_JOB_RETENTION,
        removeOnFail: FAILED_JOB_RETENTION,
      },
    });
  });

  it('attaches error listeners to queue and worker so a Redis OOM degrades instead of crashing', () => {
    makeScheduler();
    const queueErr = mockQueueOn.mock.calls.find(([evt]) => evt === 'error');
    const workerErr = mockWorkerOn.mock.calls.find(([evt]) => evt === 'error');
    expect(queueErr).toBeDefined();
    expect(workerErr).toBeDefined();
    const oom = new Error("OOM command not allowed when used memory > 'maxmemory'");
    expect(() => (queueErr?.[1] as (e: Error) => void)(oom)).not.toThrow();
    expect(() => (workerErr?.[1] as (e: Error) => void)(oom)).not.toThrow();
  });

  it('start() enqueues a repeatable daily cleanup job', async () => {
    const { scheduler } = makeScheduler();
    await scheduler.start();
    expect(mockQueueAdd).toHaveBeenCalledWith(
      'audit-retention-cleanup',
      {},
      { repeat: { pattern: '0 3 * * *' } },
    );
  });

  it('start() is a no-op when retention is disabled (never enqueues)', async () => {
    const service = { enabled: false, cleanup: vi.fn() } as never;
    const scheduler = new AuditRetentionScheduler({ redisUrl: 'redis://x:6379', service });
    await scheduler.start();
    expect(mockQueueAdd).not.toHaveBeenCalled();
  });

  it('the job processor runs the retention cleanup', async () => {
    const { cleanup } = makeScheduler(vi.fn().mockResolvedValue(7));
    expect(capturedProcessor).toBeDefined();
    await capturedProcessor!({ data: {} });
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
