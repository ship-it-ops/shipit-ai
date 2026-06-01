import type { PropertyClaim } from './claims.js';

export interface CanonicalNode {
  id: string; // shipit://{label}/{namespace}/{name}
  label: string; // Node label (e.g., 'LogicalService')
  properties: Record<string, unknown>;
  _claims: PropertyClaim[];
  _source_system: string; // e.g., 'github', 'kubernetes'
  _source_org: string; // e.g., 'github/shipitops'
  _source_id: string; // Linking key from source system
  _last_synced: string; // ISO 8601
  _event_version: number | string; // Monotonic integer or ISO 8601 only
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
