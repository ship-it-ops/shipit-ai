import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import type { EventEnvelope } from '@shipit-ai/shared';
import type { ResolvedConfig } from '../config.js';
import { EVENT_LOG_STREAM } from './producer.js';
import { FAILED_JOB_RETENTION } from './retention.js';

export class EventBusReplay {
  private readonly queue: Queue;
  private readonly redis: Redis;
  private readonly batchSize: number;

  constructor(config: ResolvedConfig) {
    this.queue = new Queue(config.queueName, {
      connection: { host: config.redisHost, port: config.redisPort, maxRetriesPerRequest: null },
      // Same bounded retention as the producer (see retention.ts).
      defaultJobOptions: { removeOnComplete: true, removeOnFail: FAILED_JOB_RETENTION },
    });
    this.redis = new Redis(config.redisPort, config.redisHost, { maxRetriesPerRequest: null });
    this.batchSize = config.batchSize;
  }

  async replay(fromTimestamp: string): Promise<void> {
    const startId = `${new Date(fromTimestamp).getTime()}-0`;
    let lastId = startId;
    let hasMore = true;

    while (hasMore) {
      const entries = await this.redis.xrange(
        EVENT_LOG_STREAM,
        lastId,
        '+',
        'COUNT',
        this.batchSize,
      );

      if (!entries || entries.length === 0) {
        hasMore = false;
        break;
      }

      const jobs = entries.map(([_id, fields]: [string, string[]]) => {
        const envelope: EventEnvelope = JSON.parse(fields[1]);
        return {
          name: 'event',
          data: envelope,
          opts: {
            // BullMQ 5 forbids `:` in custom job IDs (see producer.ts).
            // The replay prefix uses `~` for the same reason.
            jobId: `replay~${envelope.idempotency_key}`,
            // Retention inherited from the queue's defaultJobOptions.
          },
        };
      });

      await this.queue.addBulk(jobs);

      // Move past the last entry for pagination
      const lastEntry = entries[entries.length - 1];
      lastId = incrementStreamId(lastEntry[0]);

      if (entries.length < this.batchSize) {
        hasMore = false;
      }
    }
  }

  async close(): Promise<void> {
    await this.queue.close();
    this.redis.disconnect();
  }
}

function incrementStreamId(id: string): string {
  const [timestamp, sequence] = id.split('-');
  return `${timestamp}-${Number(sequence) + 1}`;
}
