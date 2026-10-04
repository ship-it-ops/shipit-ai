// Periodic work outside any one run: the heartbeat GET /ai/status reads, and a
// sweep that recovers runs whose worker died, stops runs that make no
// progress, and closes idle chats.
import type { Redis } from 'ioredis';
import { RUNNER_HEARTBEAT_KEY, type RunEvent, type RunStore } from '@shipit-ai/agents';

export interface HousekeepingOptions {
  runs: RunStore;
  redis: Redis;
  queue: { enqueue(runId: string): Promise<void> };
  publish: (event: RunEvent) => void;
  chatIdleMinutes: number;
  heartbeatEveryMs?: number;
  sweepEveryMs?: number;
  log?: (message: string) => void;
}

export class Housekeeping {
  private timers: NodeJS.Timeout[] = [];

  constructor(private readonly opts: HousekeepingOptions) {}

  start(): void {
    void this.beat();
    void this.sweep();
    this.timers = [
      setInterval(() => void this.beat(), this.opts.heartbeatEveryMs ?? 15_000),
      setInterval(() => void this.sweep(), this.opts.sweepEveryMs ?? 30_000),
    ];
  }

  stop(): void {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }

  /** Written every 15 s with a 60 s expiry: a runner gone for a minute shows as down. */
  async beat(): Promise<void> {
    try {
      await this.opts.redis.set(RUNNER_HEARTBEAT_KEY, new Date().toISOString(), 'EX', 60);
    } catch (err) {
      this.log(`heartbeat failed: ${(err as Error).message}`);
    }
  }

  async sweep(): Promise<void> {
    const { runs } = this.opts;
    try {
      for (const id of await runs.expiredLeases()) await this.opts.queue.enqueue(id);
      for (const id of await runs.failStalled()) this.opts.publish({ runId: id, status: 'failed' });
      for (const id of await runs.closeIdleChats(this.opts.chatIdleMinutes)) {
        this.opts.publish({ runId: id, status: 'succeeded' });
      }
    } catch (err) {
      this.log(`sweep failed: ${(err as Error).message}`);
    }
  }

  private log(message: string): void {
    (this.opts.log ?? console.warn)(message);
  }
}
