// The worker's main loop. Postgres is the queue: claim a batch with
// FOR UPDATE SKIP LOCKED, process it with bounded concurrency, repeat. A Redis
// wake-up shortens the wait after a sink commit; the poll interval is the
// floor. The heartbeat is what /api/knowledge/status reads for `worker`.
import { indexDocument, type IndexPipelineDeps } from './index-pipeline.js';
import type { KnowledgeStore } from './store.js';

export interface HeartbeatSink {
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export interface IndexLoopOptions {
  store: KnowledgeStore;
  pipeline: IndexPipelineDeps;
  batchSize: number;
  concurrency: number;
  /** Floor between claim attempts when no wake-up arrives. Default 10 000. */
  pollIntervalMs?: number;
  heartbeat?: { sink: HeartbeatSink; key: string; ttlSeconds: number; everyMs: number };
  log?: (line: string) => void;
}

export interface LoopStats {
  claimed: number;
  indexed: number;
  unchanged: number;
  skipped: number;
  superseded: number;
  failed: number;
}

export class IndexLoop {
  private running = false;
  private wakeResolve: (() => void) | null = null;
  // A wake-up that arrives while a batch is running has no wait to cut short;
  // it is remembered so the next claim follows straight away.
  private wakePending = false;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private loopPromise: Promise<void> | null = null;

  constructor(private readonly opts: IndexLoopOptions) {}

  /** Claims one batch and processes it. Returns what happened; tests call this directly. */
  async runOnce(): Promise<LoopStats> {
    const stats: LoopStats = {
      claimed: 0,
      indexed: 0,
      unchanged: 0,
      skipped: 0,
      superseded: 0,
      failed: 0,
    };
    const docs = await this.opts.store.claimPending(this.opts.batchSize);
    stats.claimed = docs.length;
    await mapWithConcurrency(docs, this.opts.concurrency, async (doc) => {
      try {
        const outcome = await indexDocument(this.opts.pipeline, doc);
        stats[outcome] += 1;
      } catch (err) {
        stats.failed += 1;
        const message = (err as Error).message ?? String(err);
        this.opts.log?.(`index failed for ${doc.externalId} (${doc.id}): ${message}`);
        await this.opts.store
          .markFailed(doc.id, message)
          .catch((e: Error) =>
            this.opts.log?.(`could not record the failure for ${doc.id}: ${e.message}`),
          );
      }
    });
    return stats;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.opts.heartbeat) {
      const hb = this.opts.heartbeat;
      const beat = (): void => {
        void hb.sink
          .set(hb.key, new Date().toISOString(), hb.ttlSeconds)
          .catch((err: Error) => this.opts.log?.(`heartbeat failed: ${err.message}`));
      };
      beat();
      this.heartbeatTimer = setInterval(beat, hb.everyMs);
    }
    this.loopPromise = this.loop();
  }

  /** Called on a Redis wake-up: cut the current wait short. */
  kick(): void {
    if (this.wakeResolve) this.wakeResolve();
    else this.wakePending = true;
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.kick();
    await this.loopPromise;
  }

  private async loop(): Promise<void> {
    const interval = this.opts.pollIntervalMs ?? 10_000;
    while (this.running) {
      let stats: LoopStats | null = null;
      try {
        stats = await this.runOnce();
      } catch (err) {
        // Postgres unavailable, most likely. Wait a full interval and try again.
        this.opts.log?.(`claim failed: ${(err as Error).message}`);
      }
      if (!this.running) break;
      // A full batch means more is probably waiting: go straight back.
      if (stats && stats.claimed >= this.opts.batchSize) continue;
      if (this.wakePending) {
        this.wakePending = false;
        continue;
      }
      // The timer is deliberately not unref'd: with Postgres down and no Redis
      // it is the only handle left, and the process must stay up to retry.
      let timer: NodeJS.Timeout | undefined;
      await new Promise<void>((resolve) => {
        this.wakeResolve = resolve;
        timer = setTimeout(resolve, interval);
      });
      clearTimeout(timer);
      this.wakeResolve = null;
    }
  }
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await fn(item);
    }
  });
  await Promise.all(workers);
}
