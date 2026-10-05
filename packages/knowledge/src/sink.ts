// The SDK's KnowledgeSink on Postgres. Redacts every segment before anything is
// stored (spec decision 14), then hands the batch to the store, which commits
// documents, tombstones and the checkpoint together. After a commit it pokes
// the worker through Redis pub/sub. The poke is best-effort and never waited
// for: the worker polls anyway.
import type {
  ChangeBatch,
  KnowledgeDocumentInput,
  KnowledgeRunMode,
  KnowledgeSink,
  PruneOptions,
  SelectedContainer,
  SourceContainer,
  SourcePrincipal,
} from '@shipit-ai/connector-sdk';
import { redactSegments, redactText, stripNul } from './redaction.js';
import type { KnowledgeStore } from './store.js';

export interface PostgresKnowledgeSinkOptions {
  connectorId: string;
  store: KnowledgeStore;
  /** Publishes the wake-up. Absent in tests and when Redis is down. */
  wake?: () => Promise<void>;
  log?: (line: string) => void;
}

// Names and URLs are stored as text: no NUL may survive in them.
const storable = (c: SourceContainer): SourceContainer => ({
  ...c,
  name: stripNul(c.name),
  ...(c.url ? { url: stripNul(c.url) } : {}),
});

const storablePrincipal = (p: SourcePrincipal): SourcePrincipal => ({
  ...p,
  displayName: stripNul(p.displayName),
  ...(p.email ? { email: stripNul(p.email) } : {}),
  ...(p.login ? { login: stripNul(p.login) } : {}),
});

export class PostgresKnowledgeSink implements KnowledgeSink {
  constructor(private readonly opts: PostgresKnowledgeSinkOptions) {}

  upsertContainers(containers: SourceContainer[]): Promise<void> {
    return this.opts.store.upsertContainers(this.opts.connectorId, containers.map(storable));
  }

  /** One container asked for on its own; the rest of the list is left as it is. */
  upsertContainer(container: SourceContainer): Promise<void> {
    return this.opts.store.upsertContainer(this.opts.connectorId, storable(container));
  }

  upsertPrincipals(principals: SourcePrincipal[]): Promise<void> {
    return this.opts.store.upsertPrincipals(
      this.opts.connectorId,
      principals.map(storablePrincipal),
    );
  }

  selectedContainers(mode?: KnowledgeRunMode): Promise<SelectedContainer[]> {
    return this.opts.store.selectedContainers(this.opts.connectorId, mode);
  }

  markVisited(container: SelectedContainer, mode: KnowledgeRunMode): Promise<void> {
    return this.opts.store.markVisited(this.opts.connectorId, container, mode);
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
          url: stripNul(doc.url),
          segments: [],
          title: '',
          attributes: {},
          authorExternalId: undefined,
          participantExternalIds: [],
        });
        continue;
      }
      // Everything that can reach a chunk or the model is redacted: the
      // segments and their keys, the title, heading paths, and every name and
      // string in attributes.
      let count = 0;
      const segments = await redactSegments(doc.segments);
      count += segments.count;
      const withHeadings: typeof segments.segments = [];
      for (const redacted of segments.segments) {
        // A key may be built from source text (the Markdown splitter uses the
        // heading path), and it is stored on the document and on every chunk
        // made from it. Two keys that differed only in a secret become one;
        // a chunk lists its keys as a set, so that only merges two citations.
        const key = await redactText(redacted.key);
        count += key.count;
        // Author names and URLs are identifiers, not prose: stored as they
        // are, minus any NUL, which Postgres cannot store in text or jsonb.
        const segment = {
          ...redacted,
          key: key.text,
          ...(redacted.authorName ? { authorName: stripNul(redacted.authorName) } : {}),
          ...(redacted.url ? { url: stripNul(redacted.url) } : {}),
        };
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
        url: stripNul(doc.url),
        segments: withHeadings,
        title: title.text,
        attributes: attributes.value as Record<string, unknown>,
      });
    }
    // The people the batch refers to travel with it: the store writes them in
    // the batch's own transaction, before the documents (so authors resolve)
    // and only once it has accepted the batch (so a batch refused because its
    // container was deselected or deleted leaves no names behind).
    const result = await this.opts.store.storeBatch(
      this.opts.connectorId,
      container,
      {
        ...batch,
        documents,
        ...(batch.principals ? { principals: batch.principals.map(storablePrincipal) } : {}),
      },
      redactions,
    );
    if (result.changed > 0) this.wakeWorker();
    return result;
  }

  // Not awaited. The api-server publishes on a Redis client that queues
  // commands while it is disconnected, so the promise may not settle until
  // Redis is back, and a run must not stop for that.
  private wakeWorker(): void {
    const failed = (err: unknown): void =>
      this.opts.log?.(
        `knowledge sink: wake-up failed (worker polls anyway): ${(err as Error).message}`,
      );
    try {
      void this.opts.wake?.().catch(failed);
    } catch (err) {
      failed(err);
    }
  }

  pruneMissing(
    container: SelectedContainer,
    presentIds: string[],
    options?: PruneOptions,
  ): Promise<number> {
    return this.opts.store.pruneMissing(this.opts.connectorId, container, presentIds, options);
  }
}

/**
 * Redacts every string nested anywhere in a JSON value, property names
 * included (a source's custom field names are source text too); other values
 * pass through.
 */
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
      const name = await redactText(k);
      const r = await redactStrings(v);
      count += name.count + r.count;
      out[name.text] = r.value;
    }
    return { value: out, count };
  }
  return { value, count: 0 };
}
