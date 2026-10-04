// The shipit-agent-runs queue, for the two processes that add to it: the
// api-server (a new run, a chat message) and the runner (a run to recover).
// Jobs carry only a run id: state lives in Postgres, and the run's lease (not
// BullMQ) decides who works on it, so a duplicate job is a harmless no-op and
// `attempts` stays 1.
import { Queue, type ConnectionOptions } from 'bullmq';
import { AGENT_RUNS_QUEUE, type RunJob } from './queues.js';

// Bounded like the other queues: completed jobs for a day, failed for a week.
const COMPLETED_JOB_RETENTION = { age: 24 * 3600, count: 1000 };
const FAILED_JOB_RETENTION = { age: 7 * 24 * 3600, count: 5000 };

export interface RunQueueOptions {
  redisUrl: string;
  queueName?: string;
  log?: (message: string) => void;
}

export class RunQueue {
  private readonly queue: Queue<RunJob>;

  constructor(opts: RunQueueOptions) {
    const log = opts.log ?? console.warn;
    this.queue = new Queue<RunJob>(opts.queueName ?? AGENT_RUNS_QUEUE, {
      connection: parseRedisUrl(opts.redisUrl),
      defaultJobOptions: {
        attempts: 1,
        removeOnComplete: COMPLETED_JOB_RETENTION,
        removeOnFail: FAILED_JOB_RETENTION,
      },
    });
    // Without a listener an emitted 'error' crashes the process (scar
    // redis-memory-limit-below-dataset-oomkills).
    this.queue.on('error', (err: Error) => log(`agent-runs queue error: ${err.message}`));
  }

  async enqueue(runId: string): Promise<void> {
    await this.queue.add('run', { runId });
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

// Parse a redis:// URL into the host/port/password shape BullMQ's
// ConnectionOptions expects, rather than handing BullMQ an ioredis instance
// the type checker cannot reconcile across hoisted versions. (The api-server's
// older queues keep their own copies for the same reason.)
export function parseRedisUrl(url: string): ConnectionOptions {
  const u = new URL(url);
  return {
    host: u.hostname || '127.0.0.1',
    port: u.port ? Number(u.port) : 6379,
    password: u.password || undefined,
    username: u.username || undefined,
    db: u.pathname && u.pathname.length > 1 ? Number(u.pathname.slice(1)) : undefined,
    maxRetriesPerRequest: null,
  };
}
