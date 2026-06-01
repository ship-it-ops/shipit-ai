import type { ResolutionStrategy } from './claims.js';

export type SchemaMode = 'full' | 'simple';

export interface SchemaPropertyDef {
  type: string; // 'string', 'integer', 'boolean', 'string[]'
  required?: boolean;
  resolution_strategy: ResolutionStrategy;
  enum?: string[];
  description?: string;
}

export interface SchemaNodeTypeDef {
  description: string;
  properties: Record<string, SchemaPropertyDef>;
  constraints?: {
    unique_key?: string;
  };
}

/**
 * Behavioral categories the UI uses to group relationships. Marking a
 * relationship as `ownership` opts it into the Owner filter on the graph
 * explorer — the source node's `name` is treated as an owner of the target.
 * Kept as a single-value union for now; widen as more categories emerge.
 */
export type RelTypeSemantics = 'ownership';

export interface SchemaRelTypeDef {
  from: string;
  to: string;
  cardinality: '1:1' | '1:N' | 'N:1' | 'N:M';
  properties?: Record<string, SchemaPropertyDef>;
  description?: string;
  semantics?: RelTypeSemantics;
}

export interface ShipItSchema {
  version: string;
  mode: SchemaMode;
  node_types: Record<string, SchemaNodeTypeDef>;
  relationship_types: Record<string, SchemaRelTypeDef>;
  resolution_defaults?: Record<string, ResolutionStrategy>;
}
