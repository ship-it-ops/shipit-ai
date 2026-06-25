// Core Writer
export { CoreWriter } from './writer.js';
export type { WriteResult, NodeWriter, WriteNodeResult, ExistingClaims } from './writer.js';

// Claims
export { ClaimResolver } from './claims/resolver.js';
export type { ResolverOptions } from './claims/resolver.js';
export { resolveClaims } from './claims/strategies.js';

// Identity
export { IdentityReconciler } from './identity/reconciler.js';
export type { ReconciliationResult } from './identity/reconciler.js';
export { InMemoryLinkingKeyIndex } from './identity/linking-key-index.js';
export type { LinkingKeyIndex } from './identity/linking-key-index.js';

// Idempotency
export {
  buildIdempotencyKey,
  buildNodeIdempotencyKey,
  InMemoryIdempotencyChecker,
} from './idempotency.js';
export type { IdempotencyChecker } from './idempotency.js';

// Batch
export { BatchProcessor } from './batch.js';

// Neo4j
export { Neo4jClient } from './neo4j/client.js';
export {
  mergeNode,
  mergeEdge,
  checkIdempotencyKey,
  writeIdempotencyKey,
  registerLinkingKey,
  lookupLinkingKey,
  getExistingClaims,
  cleanupExpiredIdempotencyKeys,
} from './neo4j/queries.js';
export type { MergeNodeResult, ExistingClaims as Neo4jExistingClaims } from './neo4j/queries.js';

// Config
export { DEFAULT_CONFIG } from './config.js';
export type { CoreWriterConfig } from './config.js';
