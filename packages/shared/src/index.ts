// Types
export type { CanonicalNode, CanonicalEdge, CanonicalEntity } from './types/canonical.js';

export type {
  PropertyClaim,
  ResolutionStrategy,
  EdgeClaim,
  ClaimResolutionResult,
} from './types/claims.js';

export type {
  SchemaMode,
  SchemaPropertyDef,
  SchemaNodeTypeDef,
  SchemaRelTypeDef,
  ShipItSchema,
} from './types/schema.js';

export type { EventEnvelope, EventHandler, EventBusClient } from './types/events.js';

export type { RenameSignal, MergeEvent, IdentityMatchStep } from './types/identity.js';

export type {
  CypherQueryRequest,
  CypherQueryResponse,
  CypherQueryError,
} from './types/query-api.js';

export type { ResolvedProperty, EntityClaims, ConflictRow } from './types/claims-api.js';

export type {
  SchemaSnapshot,
  SchemaDiff,
  SchemaTypeChange,
  SchemaWithHistory,
  MigrationImpact,
  MigrationPreview,
  SchemaVersionConflict,
} from './types/schema-api.js';

export type {
  TeamSummary,
  TeamDetail,
  TeamOwnedEntity,
  TeamMember,
  OnCallAssignment,
} from './types/team-api.js';

export type {
  ReconciliationCandidate,
  CandidateDetail,
  MergeEventSummary,
  ReconciliationStats,
} from './types/reconciliation-api.js';

// Identity utilities
export { buildCanonicalId, parseCanonicalId, isValidCanonicalId } from './identity/canonical-id.js';

export { buildLinkingKey, parseLinkingKey } from './identity/linking-key.js';

export type { ConnectorType } from './identity/linking-key.js';

// Schema
export { parseSchemaFile } from './schema/parser.js';
export { validateSchema, validateSchemaRelationships } from './schema/validator.js';
export { DEFAULT_SCHEMA } from './schema/defaults.js';

// Utilities
export { computeEffectiveConfidence } from './utils/confidence.js';

// Config
export {
  loadConfig,
  findConfigPaths,
  configSchema,
  connectorInstanceSchema,
  resolveAppCredentials,
} from './config/index.js';
export type {
  Config,
  LoadConfigOptions,
  ConfigPaths,
  ConnectorInstanceConfig,
  GitHubConnectorConfig,
  ResolvedAppCredentials,
  AppLike,
} from './config/index.js';
