import type { EventEnvelope } from '@shipit-ai/shared';

export interface BatchProcessorOptions {
  batchSize: number;
  flushIntervalMs?: number;
}

export class BatchProcessor {
  private buffer: EventEnvelope[] = [];
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly onFlush: (batch: EventEnvelope[]) => Promise<void>;

  constructor(onFlush: (batch: EventEnvelope[]) => Promise<void>, options: BatchProcessorOptions) {
    this.onFlush = onFlush;
    this.batchSize = options.batchSize;
    this.flushIntervalMs = options.flushIntervalMs ?? 5000;
  }

  start(): void {
    this.flushTimer = setInterval(() => {
      // Errors thrown inside the periodic flush would be unhandled rejections
      // otherwise; log them so silent write failures don't go unnoticed.
      void this.flush().catch((err) => {
        console.error('[BatchProcessor] timer flush threw:', err);
      });
    }, this.flushIntervalMs);
  }

  async add(event: EventEnvelope): Promise<void> {
    this.buffer.push(event);
    if (this.buffer.length >= this.batchSize) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer.splice(0, this.batchSize);
    await this.onFlush(batch);
  }

  async stop(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
  }

  get pendingCount(): number {
    return this.buffer.length;
  }
}
