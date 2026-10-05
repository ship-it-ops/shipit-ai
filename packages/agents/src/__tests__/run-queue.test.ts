import { describe, it, expect } from 'vitest';
import { RunQueue } from '../run-queue.js';

describe('RunQueue', () => {
  // With Redis down, BullMQ queues the command and waits for the connection:
  // the caller (an HTTP request) would wait with it. A bounded wait lets the
  // route answer 503 and fail the run instead.
  it('rejects an enqueue the queue does not take in time', async () => {
    const queue = new RunQueue({
      redisUrl: 'redis://127.0.0.1:1', // nothing listens here
      enqueueTimeoutMs: 150,
      log: () => {},
    });
    try {
      const started = Date.now();
      await expect(queue.enqueue('3f0e4c1a-0000-4000-8000-000000000000')).rejects.toThrow(
        'The run queue did not answer within 150 ms.',
      );
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await queue.close();
    }
  });
});
