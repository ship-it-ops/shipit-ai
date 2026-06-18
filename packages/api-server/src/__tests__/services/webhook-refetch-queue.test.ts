import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock bullmq + ioredis ─────────────────────────────────────────────────
// Mirrors sync-scheduler.test.ts. The Worker mock must provide `.on` (the queue
// attaches a 'failed' listener in its ctor). ioredis is mocked because the
// queue opens a dedicated client for the SETNX delivery-dedup keys.
const mockQueueAdd = vi.fn().mockResolvedValue(undefined);
const mockQueueClose = vi.fn().mockResolvedValue(undefined);
const mockWorkerOn = vi.fn();
const mockWorkerClose = vi.fn().mockResolvedValue(undefined);

vi.mock('bullmq', () => ({
  Queue: vi.fn().mockImplementation(() => ({ add: mockQueueAdd, close: mockQueueClose })),
  Worker: vi.fn().mockImplementation(() => ({ on: mockWorkerOn, close: mockWorkerClose })),
}));

const mockRedisSet = vi.fn();
const mockRedisDel = vi.fn();
const mockRedisDisconnect = vi.fn();
vi.mock('ioredis', () => ({
  Redis: vi.fn().mockImplementation(() => ({
    set: mockRedisSet,
    del: mockRedisDel,
    disconnect: mockRedisDisconnect,
  })),
}));

import { Queue } from 'bullmq';
import { COMPLETED_JOB_RETENTION, FAILED_JOB_RETENTION } from '@shipit-ai/event-bus';
import { WebhookRefetchQueue } from '../../services/webhook-refetch-queue.js';

function makeQueue() {
  return new WebhookRefetchQueue({
    redisUrl: 'redis://localhost:6379',
    registry: {} as never,
    eventBus: {} as never,
    globalApp: {} as never,
  });
}

describe('WebhookRefetchQueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('constructs its queue with a colon-free name + bounded retention', () => {
    makeQueue();
    const call = vi.mocked(Queue).mock.calls.at(-1);
    // BullMQ 5 forbids ':' in queue names (reserves it for bull:<queue>:<key>).
    expect(call?.[0]).toBe('shipit-webhook-refetch');
    expect(call?.[0]).not.toContain(':');
    expect(call?.[1]).toMatchObject({
      defaultJobOptions: {
        removeOnComplete: COMPLETED_JOB_RETENTION,
        removeOnFail: FAILED_JOB_RETENTION,
      },
    });
  });

  it('enqueues with a deterministic, colon-free job id and a coalescing delay', async () => {
    const queue = makeQueue();
    // Inputs deliberately contain ':' to prove the BullMQ-5 colon scar is handled.
    await queue.enqueue({ connectorId: 'conn:a', owner: 'acme', repo: 'wid:gets', kind: 'repo' });

    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
    const [name, data, opts] = mockQueueAdd.mock.calls[0];
    expect(name).toBe('refetch');
    expect(data).toEqual({ connectorId: 'conn:a', owner: 'acme', repo: 'wid:gets', kind: 'repo' });
    // Colons replaced with '~'; deterministic so a burst collapses onto one job.
    expect(opts.jobId).toBe('conn~a~acme~wid~gets~repo');
    expect(opts.jobId).not.toContain(':');
    expect(opts.delay).toBeGreaterThan(0);
  });

  it('markDeliverySeen returns true only when the SETNX key was absent', async () => {
    const queue = makeQueue();

    mockRedisSet.mockResolvedValueOnce('OK'); // key was absent → new delivery
    expect(await queue.markDeliverySeen('d-1')).toBe(true);

    mockRedisSet.mockResolvedValueOnce(null); // key present → duplicate
    expect(await queue.markDeliverySeen('d-1')).toBe(false);

    const [key, val, ex, ttl, nx] = mockRedisSet.mock.calls[0];
    expect(key).toBe('wh~delivery~d-1');
    expect(val).toBe('1');
    expect(ex).toBe('EX');
    expect(ttl).toBeGreaterThan(0);
    expect(nx).toBe('NX');
  });

  it('releaseDelivery DELs the same dedup key markDeliverySeen would set', async () => {
    const queue = makeQueue();
    await queue.releaseDelivery('d-1');
    expect(mockRedisDel).toHaveBeenCalledWith('wh~delivery~d-1');
  });

  it('close() tears down worker, queue, and the dedup redis client', async () => {
    const queue = makeQueue();
    await queue.close();
    expect(mockWorkerClose).toHaveBeenCalledTimes(1);
    expect(mockQueueClose).toHaveBeenCalledTimes(1);
    expect(mockRedisDisconnect).toHaveBeenCalledTimes(1);
  });
});
