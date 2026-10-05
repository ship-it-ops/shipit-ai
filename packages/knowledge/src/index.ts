export { VECTOR_EXTENSION, ensureVectorExtension, hasVectorExtension } from './bootstrap.js';
export { KNOWLEDGE_WAKE_CHANNEL, KNOWLEDGE_WORKER_HEARTBEAT_KEY } from './channels.js';
export { INDEX_VERSION, KNOWLEDGE_MIGRATIONS } from './schema-version.js';
export { missingKnowledgeMigrations } from './status.js';
export { contentHashOf, sha256Hex } from './hash.js';
export { redactSegments, redactText } from './redaction.js';
export type { Redacted } from './redaction.js';
export { chunkDocument, estimateTokens, splitLongText } from './chunking.js';
export type { ChunkDraft, ChunkableDocument, ChunkingOptions } from './chunking.js';
export { toPgVector } from './vector.js';
export { CLAIM_STALE_MS, KnowledgeStore, MAX_INDEX_ATTEMPTS } from './store.js';
export type { ContainerRow, ContainerSummary, DocumentRow, StoredChunkInput } from './store.js';
export { PostgresKnowledgeSink } from './sink.js';
export type { PostgresKnowledgeSinkOptions } from './sink.js';
export {
  EmbeddingDimensionError,
  FakeEmbedder,
  TEXTS_PER_EMBEDDING_CALL,
  assertDimensions,
  isRetryableEmbeddingError,
  withRetry,
} from './embedder.js';
export type { Embedder, RetryOptions } from './embedder.js';
export { indexDocument } from './index-pipeline.js';
export type { IndexOutcome, IndexPipelineDeps, IndexStore } from './index-pipeline.js';
export { IndexLoop } from './index-loop.js';
export type { HeartbeatSink, IndexLoopOptions, LoopStats } from './index-loop.js';
