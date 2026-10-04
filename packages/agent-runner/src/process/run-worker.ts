// The runner's side of the shipit-agent-runs queue: a BullMQ worker that hands
// each job's run id to the run loop. The run's lease (not BullMQ) decides who
// works on a run, so a duplicate job is a harmless no-op.
import { Worker, type Job } from 'bullmq';
import {
  AGENT_RUNS_QUEUE,
  parseRedisUrl,
  type RunJob,
  type RunQueueOptions,
} from '@shipit-ai/agents';
import type { AgentRuntime } from '../loop/agent-loop.js';

export interface RunWorkerOptions extends RunQueueOptions {
  concurrency: number;
  runtime: AgentRuntime;
}

export class RunWorker {
  private readonly worker: Worker<RunJob>;

  constructor(opts: RunWorkerOptions) {
    const log = opts.log ?? console.warn;
    this.worker = new Worker<RunJob>(
      opts.queueName ?? AGENT_RUNS_QUEUE,
      async (job: Job<RunJob>) => opts.runtime.process(job.data.runId),
      { connection: parseRedisUrl(opts.redisUrl), concurrency: opts.concurrency },
    );
    this.worker.on('error', (err: Error) => log(`agent-runs worker error: ${err.message}`));
    this.worker.on('failed', (job: Job<RunJob> | undefined, err: Error) =>
      log(`run ${job?.data.runId ?? '?'} failed in the worker: ${err.message}`),
    );
  }

  async close(): Promise<void> {
    await this.worker.close();
  }
}
