import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock bullmq ───────────────────────────────────────────────────────
// First BullMQ-mock test in api-server; the spy pattern is ported from
// packages/event-bus/src/__tests__/event-bus.test.ts. The Worker mock must
// provide `.on` (the scheduler attaches a 'failed' listener in its ctor).
const mockQueueAdd = vi.fn().mockResolvedValue(undefined);
const mockQueueClose = vi.fn().mockResolvedValue(undefined);
const mockWorkerOn = vi.fn();
const mockWorkerClose = vi.fn().mockResolvedValue(undefined);

vi.mock('bullmq', () => {
  const Queue = vi.fn().mockImplementation(() => ({
    add: mockQueueAdd,
    getRepeatableJobs: vi.fn().mockResolvedValue([]),
    removeRepeatableByKey: vi.fn().mockResolvedValue(undefined),
    close: mockQueueClose,
  }));
  const Worker = vi.fn().mockImplementation(() => ({
    on: mockWorkerOn,
    close: mockWorkerClose,
  }));
  return { Queue, Worker };
});

import { Queue } from 'bullmq';
import { SyncScheduler } from '../../services/sync-scheduler.js';
import { COMPLETED_JOB_RETENTION, FAILED_JOB_RETENTION } from '@shipit-ai/event-bus';
import type { GitHubConnectorConfig } from '@shipit-ai/shared';

function makeScheduler() {
  return new SyncScheduler({
    redisUrl: 'redis://localhost:6379',
    registry: {} as never,
    eventBus: {} as never,
    globalApp: { appId: '', privateKey: '' } as never,
  });
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

  it('still enqueues a repeatable poll job on start()', async () => {
    const scheduler = makeScheduler();
    await scheduler.start({
      id: 'github-shipitops',
      enabled: true,
      schedule: '*/5 * * * *',
    } as GitHubConnectorConfig);

    expect(mockQueueAdd).toHaveBeenCalledWith(
      'poll:github-shipitops',
      { connectorId: 'github-shipitops', mode: 'incremental' },
      { repeat: { pattern: '*/5 * * * *' } },
    );
  });
});
