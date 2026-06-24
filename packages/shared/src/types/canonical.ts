import type { PropertyClaim } from './claims.js';

export interface CanonicalNode {
  id: string; // shipit://{label}/{namespace}/{name}
  label: string; // Node label (e.g., 'LogicalService')
  properties: Record<string, unknown>;
  _claims: PropertyClaim[];
  _source_system: string; // e.g., 'github', 'kubernetes'
  _source_org: string; // e.g., 'github/shipitops'
  _source_id: string; // Linking key from source system
  // Connector instance ID that produced this entity (e.g. 'gh-acme-prod').
  // Set by the core-writer from the event envelope, not by the normalizer —
  // a normalizer doesn't know which configured instance dispatched the sync.
  // Optional because pre-existing nodes from before this field was added
  // won't have it until the next sync rewrites them.
  _source_connector_id?: string;
  _last_synced: string; // ISO 8601
  // Freshness/ORDERING token (Cut B). Either a comparable epoch-ms number (entities
  // with a source timestamp — Repository/Pipeline) OR an opaque, sentinel-prefixed
  // (`ch_…`) content hash for entities without one (Team/Person — unorderable,
  // last-writer-wins). The core-writer's atomic in-Cypher guard skips a write only
  // when this is a number strictly less than the stored value. NOT the dedup key —
  // that is a separate content fingerprint (see shared `deriveNodeContentHash`).
  _event_version: number | string;
}

export interface CanonicalEdge {
  type: string; // e.g., 'DEPENDS_ON'
  from: string; // Source node canonical ID
  to: string; // Target node canonical ID
  properties?: Record<string, unknown>;
  _source: string;
  _confidence: number; // 0.0-1.0
  _ingested_at: string; // ISO 8601
}

export interface CanonicalEntity {
  nodes: CanonicalNode[];
  edges: CanonicalEdge[];
}
