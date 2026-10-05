// One document through the index: skip what has no content, do nothing when
// nothing changed, otherwise chunk, embed only the chunks whose text is new,
// and replace the stored chunks in one transaction (spec §Index pipeline).
import { chunkDocument, type ChunkingOptions } from './chunking.js';
import {
  TEXTS_PER_EMBEDDING_CALL,
  assertDimensions,
  isRetryableEmbeddingError,
  withRetry,
  type Embedder,
} from './embedder.js';
import type { DocumentRow, StoredChunkInput } from './store.js';
import { toPgVector } from './vector.js';

/** `superseded`: the sink changed the document while it was being indexed; nothing was written. */
export type IndexOutcome = 'indexed' | 'unchanged' | 'skipped' | 'superseded';

/** The slice of KnowledgeStore the pipeline uses; tests fake it in memory. */
export interface IndexStore {
  existingChunkEmbeddings(documentId: string, model: string): Promise<Map<string, string>>;
  replaceChunks(
    documentId: string,
    chunks: StoredChunkInput[],
    meta: { indexedHash: string; indexVersion: number },
  ): Promise<boolean>;
  markUnchanged(documentId: string, indexVersion: number): Promise<void>;
  markSkipped(documentId: string): Promise<void>;
  /** Renews the claim on a document still being embedded; false when it is no longer this claim. */
  keepClaim(documentId: string, contentHash: string): Promise<boolean>;
}

export interface IndexPipelineDeps {
  store: IndexStore;
  embedder: Embedder;
  chunking: ChunkingOptions;
  indexVersion: number;
  /** Container display name for the chunk prefix. Cached by the caller. */
  containerNameOf(containerId: string): Promise<string>;
}

/**
 * `signal` is the worker's stop signal: it ends an embedding call in flight,
 * and nothing is retried once it has fired. `onProgress` is called each time
 * an embedding call of a document that needs several has come back.
 */
export async function indexDocument(
  deps: IndexPipelineDeps,
  doc: DocumentRow,
  signal?: AbortSignal,
  onProgress?: () => void,
): Promise<IndexOutcome> {
  if (doc.deletedAt || doc.restricted || doc.segments.length === 0 || !doc.contentHash) {
    await deps.store.markSkipped(doc.id);
    return 'skipped';
  }
  if (doc.indexedHash === doc.contentHash && doc.indexVersion === deps.indexVersion) {
    await deps.store.markUnchanged(doc.id, deps.indexVersion);
    return 'unchanged';
  }

  const drafts = chunkDocument(
    {
      kind: doc.kind,
      title: doc.title,
      segments: doc.segments,
      attributes: doc.attributes,
      containerName: await deps.containerNameOf(doc.containerId),
    },
    deps.chunking,
  );

  const reusable = await deps.store.existingChunkEmbeddings(doc.id, deps.embedder.model);
  const toEmbed = drafts.filter((d) => !reusable.has(d.textHash));
  const byHash = new Map(reusable);
  // A call at a time. How long a document takes grows with its length, so
  // what is sized for one call works a call at a time: a failed call is tried
  // again by itself, and between calls the claim is renewed (it would
  // otherwise go stale, and a second worker take the document halfway) and
  // the caller is told there was progress.
  for (let from = 0; from < toEmbed.length; from += TEXTS_PER_EMBEDDING_CALL) {
    if (from > 0) {
      // The sink changed or removed the document meanwhile: nothing of this
      // would be written at the end.
      if (!(await deps.store.keepClaim(doc.id, doc.contentHash))) return 'superseded';
      onProgress?.();
    }
    const slice = toEmbed.slice(from, from + TEXTS_PER_EMBEDDING_CALL);
    const vectors = await withRetry(
      () =>
        deps.embedder.embedDocuments(
          slice.map((d) => `${d.prefix}\n${d.text}`),
          { title: doc.title, ...(signal ? { signal } : {}) },
        ),
      { isRetryable: (err) => !signal?.aborted && isRetryableEmbeddingError(err) },
    );
    if (vectors.length !== slice.length) {
      throw new Error(`embedder returned ${vectors.length} vectors for ${slice.length} chunks`);
    }
    assertDimensions(vectors, deps.embedder.dimensions);
    slice.forEach((d, i) => byHash.set(d.textHash, toPgVector(vectors[i]!)));
  }

  const written = await deps.store.replaceChunks(
    doc.id,
    drafts.map((d) => ({
      seq: d.seq,
      segmentKeys: d.segmentKeys,
      url: d.url,
      occurredAt: d.occurredAt,
      prefix: d.prefix,
      text: d.text,
      textHash: d.textHash,
      tokenEstimate: d.tokenEstimate,
      embedding: byHash.get(d.textHash)!,
      embeddingModel: deps.embedder.model,
    })),
    { indexedHash: doc.contentHash, indexVersion: deps.indexVersion },
  );
  return written ? 'indexed' : 'superseded';
}
