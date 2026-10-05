// The worker's main loop. Postgres is the queue: claim a batch with
// FOR UPDATE SKIP LOCKED, process it with bounded concurrency, repeat. A Redis
// wake-up shortens the wait after a sink commit; the poll interval is the
// floor. The heartbeat is what /api/knowledge/status reads for `worker`, and
// it is written only while the loop is alive.
import { indexDocument, type IndexPipelineDeps } from './index-pipeline.js';
import type { DocumentRow, KnowledgeStore } from './store.js';

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
  heartbeat?: {
    sink: HeartbeatSink;
    key: string;
    ttlSeconds: number;
    everyMs: number;
    /**
     * No heartbeat is written once the loop has neither claimed nor finished
     * anything for this long while it had work. Default 15 minutes, which is
     * longer than the longest single step (an embedding call's deadline).
     */
    stallAfterMs?: number;
  };
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

const DEFAULT_STALL_AFTER_MS = 15 * 60_000;

export class IndexLoop {
  private running = false;
  // Aborted by stop(): embedding calls in flight end, and no document is started.
  private stopping = new AbortController();
  // When the loop last claimed a batch or finished a document.
  private lastProgressAt = Date.now();
  // True while the loop waits for work: idle, not stalled.
  private waiting = false;
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
    this.lastProgressAt = Date.now();
    const signal = this.stopping.signal;
    // Being stopped is not the document failing. Its claim is handed back with
    // no attempt spent, so the next worker takes it at once instead of after
    // the ten-minute stale reclaim.
    const handBack = (doc: DocumentRow): Promise<void> =>
      this.opts.store
        .releaseClaim(doc.id)
        .catch((e: Error) => this.opts.log?.(`could not hand back ${doc.id}: ${e.message}`));
    await mapWithConcurrency(docs, this.opts.concurrency, async (doc) => {
      if (signal.aborted) return handBack(doc);
      try {
        const outcome = await indexDocument(this.opts.pipeline, doc, signal);
        stats[outcome] += 1;
        this.lastProgressAt = Date.now();
      } catch (err) {
        if (signal.aborted) return handBack(doc);
        this.lastProgressAt = Date.now();
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
    this.stopping = new AbortController();
    this.lastProgressAt = Date.now();
    if (this.opts.heartbeat) {
      const hb = this.opts.heartbeat;
      const stallAfterMs = hb.stallAfterMs ?? DEFAULT_STALL_AFTER_MS;
      const beat = (): void => {
        // On its own timer the heartbeat would keep saying "healthy" while the
        // loop is wedged. It is written while the loop waits for work, or has
        // claimed or finished something recently.
        if (!this.waiting && Date.now() - this.lastProgressAt > stallAfterMs) return;
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

  /**
   * Stops without waiting for the batch: embedding calls in flight are
   * aborted, and every document still claimed is handed back. A stop that
   * waited for all of them could outlast the pod's grace period.
   */
  async stop(): Promise<void> {
    this.running = false;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.stopping.abort(new Error('the worker is stopping'));
    this.kick();
    await this.loopPromise;
  }

  private async loop(): Promise<void> {
    const interval = this.opts.pollIntervalMs ?? 10_000;
    while (this.running) {
      let stats: LoopStats | null = null;
      const startedAt = Date.now();
      this.lastProgressAt = startedAt;
      try {
        stats = await this.runOnce();
        if (stats.claimed > 0) {
          this.opts.log?.(
            `batch: ${stats.claimed} claimed, ${stats.indexed} indexed, ${stats.unchanged} unchanged, ` +
              `${stats.skipped} skipped, ${stats.superseded} superseded, ${stats.failed} failed, ` +
              `in ${Date.now() - startedAt} ms`,
          );
        }
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
      this.waiting = true;
      await new Promise<void>((resolve) => {
        this.wakeResolve = resolve;
        timer = setTimeout(resolve, interval);
      });
      this.waiting = false;
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
