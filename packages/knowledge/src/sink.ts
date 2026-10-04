// The SDK's KnowledgeSink on Postgres. Redacts every segment before anything is
// stored (spec decision 14), then hands the batch to the store, which commits
// documents, tombstones and the checkpoint together. After a commit it pokes
// the worker through Redis pub/sub; the poke is best-effort because the worker
// polls anyway.
import type {
  ChangeBatch,
  KnowledgeDocumentInput,
  KnowledgeSink,
  SelectedContainer,
  SourceContainer,
  SourcePrincipal,
} from '@shipit-ai/connector-sdk';
import { redactSegments } from './redaction.js';
import type { KnowledgeStore } from './store.js';

export interface PostgresKnowledgeSinkOptions {
  connectorId: string;
  store: KnowledgeStore;
  /** Publishes the wake-up. Absent in tests and when Redis is down. */
  wake?: () => Promise<void>;
  log?: (line: string) => void;
}

export class PostgresKnowledgeSink implements KnowledgeSink {
  constructor(private readonly opts: PostgresKnowledgeSinkOptions) {}

  upsertContainers(containers: SourceContainer[]): Promise<void> {
    return this.opts.store.upsertContainers(this.opts.connectorId, containers);
  }

  upsertPrincipals(principals: SourcePrincipal[]): Promise<void> {
    return this.opts.store.upsertPrincipals(this.opts.connectorId, principals);
  }

  selectedContainers(): Promise<SelectedContainer[]> {
    return this.opts.store.selectedContainers(this.opts.connectorId);
  }

  async storeBatch(
    container: SelectedContainer,
    batch: ChangeBatch,
  ): Promise<{ changed: number; deleted: number }> {
    const redactions = new Map<string, number>();
    const documents: KnowledgeDocumentInput[] = [];
    for (const doc of batch.documents) {
      if (doc.restricted) {
        documents.push({ ...doc, segments: [] });
        continue;
      }
      const redacted = await redactSegments(doc.segments);
      if (redacted.count > 0) redactions.set(doc.externalId, redacted.count);
      documents.push({ ...doc, segments: redacted.segments });
    }
    const result = await this.opts.store.storeBatch(
      this.opts.connectorId,
      container,
      { ...batch, documents },
      redactions,
    );
    if (result.changed > 0 && this.opts.wake) {
      try {
        await this.opts.wake();
      } catch (err) {
        this.opts.log?.(
          `knowledge sink: wake-up failed (worker polls anyway): ${(err as Error).message}`,
        );
      }
    }
    return result;
  }

  pruneMissing(container: SelectedContainer, presentIds: string[]): Promise<number> {
    return this.opts.store.pruneMissing(this.opts.connectorId, container, presentIds);
  }
}
