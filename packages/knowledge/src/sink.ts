// The SDK's KnowledgeSink on Postgres. Redacts every segment before anything is
// stored (spec decision 14), then hands the batch to the store, which commits
// documents, tombstones and the checkpoint together. After a commit it pokes
// the worker through Redis pub/sub; the poke is best-effort because the worker
// polls anyway.
import type {
  ChangeBatch,
  KnowledgeDocumentInput,
  KnowledgeSink,
  PruneOptions,
  SelectedContainer,
  SourceContainer,
  SourcePrincipal,
} from '@shipit-ai/connector-sdk';
import { redactSegments, redactText } from './redaction.js';
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
        // A restricted stub is stored the way a tombstone is: no content at all.
        documents.push({
          ...doc,
          segments: [],
          title: '',
          attributes: {},
          authorExternalId: undefined,
          participantExternalIds: [],
        });
        continue;
      }
      // Everything that can reach a chunk prefix or the model is redacted: the
      // segments, the title, heading paths and every string in attributes.
      let count = 0;
      const segments = await redactSegments(doc.segments);
      count += segments.count;
      const withHeadings: typeof segments.segments = [];
      for (const segment of segments.segments) {
        if (!segment.headingPath) {
          withHeadings.push(segment);
          continue;
        }
        const headingPath: string[] = [];
        for (const heading of segment.headingPath) {
          const r = await redactText(heading);
          count += r.count;
          headingPath.push(r.text);
        }
        withHeadings.push({ ...segment, headingPath });
      }
      const title = await redactText(doc.title);
      count += title.count;
      const attributes = await redactStrings(doc.attributes);
      count += attributes.count;
      if (count > 0) redactions.set(doc.externalId, count);
      documents.push({
        ...doc,
        segments: withHeadings,
        title: title.text,
        attributes: attributes.value as Record<string, unknown>,
      });
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

  pruneMissing(
    container: SelectedContainer,
    presentIds: string[],
    options?: PruneOptions,
  ): Promise<number> {
    return this.opts.store.pruneMissing(this.opts.connectorId, container, presentIds, options);
  }
}

/** Redacts every string nested anywhere in a JSON value; other values pass through. */
async function redactStrings(value: unknown): Promise<{ value: unknown; count: number }> {
  if (typeof value === 'string') {
    const r = await redactText(value);
    return { value: r.text, count: r.count };
  }
  if (Array.isArray(value)) {
    let count = 0;
    const out: unknown[] = [];
    for (const item of value) {
      const r = await redactStrings(item);
      count += r.count;
      out.push(r.value);
    }
    return { value: out, count };
  }
  if (value && typeof value === 'object') {
    let count = 0;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const r = await redactStrings(v);
      count += r.count;
      out[k] = r.value;
    }
    return { value: out, count };
  }
  return { value, count: 0 };
}
