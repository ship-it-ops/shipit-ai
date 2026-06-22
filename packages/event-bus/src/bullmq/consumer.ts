import { Worker, type Job } from 'bullmq';
import type { EventEnvelope, EventHandler } from '@shipit-ai/shared';
import type { ResolvedConfig } from '../config.js';

export class EventBusConsumer {
  private worker: Worker | null = null;
  private readonly config: ResolvedConfig;

  constructor(config: ResolvedConfig) {
    this.config = config;
  }

  async subscribe(handler: EventHandler): Promise<void> {
    if (this.worker) {
      throw new Error('Already subscribed. Call close() before re-subscribing.');
    }

    this.worker = new Worker<EventEnvelope>(
      this.config.queueName,
      async (job: Job<EventEnvelope>) => {
        await handler(job.data);
      },
      {
        connection: {
          host: this.config.redisHost,
          port: this.config.redisPort,
          maxRetriesPerRequest: null,
        },
        concurrency: this.config.concurrency,
        autorun: true,
      },
    );

    // The Worker is an EventEmitter; an emitted 'error' with no listener
    // rethrows as an uncaughtException and kills the process. A full Redis makes
    // the worker's `moveToActive` Lua eval emit 'error' (`OOM command not
    // allowed`) — log and degrade rather than crash the subscriber.
    this.worker.on('error', (err: Error) => {
      console.warn(`EventBus consumer worker Redis error (consumption degraded): ${err.message}`);
    });

    await this.worker.waitUntilReady();
  }

  async close(): Promise<void> {
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
  }
}
