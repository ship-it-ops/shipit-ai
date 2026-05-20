import type { ShipItSchema } from './schema.js';

export interface SchemaSnapshot {
  version: string; // ISO 8601 timestamp — also the file suffix
  actor: string;
  size: number;
}

export interface SchemaDiff {
  added: { node_types: string[]; relationship_types: string[] };
  removed: { node_types: string[]; relationship_types: string[] };
  changed: SchemaTypeChange[];
}

export interface SchemaTypeChange {
  kind: 'node_type' | 'relationship_type';
  name: string;
  added_properties: string[];
  removed_properties: string[];
  changed_properties: Array<{ name: string; field: string; before: unknown; after: unknown }>;
  /**
   * Top-level changes on the type itself, not its properties. For relationship
   * types this covers `from` / `to` / `cardinality`; for node types this covers
   * `description` and `constraints.unique_key`. Empty when only property
   * additions/removals/changes occurred.
   */
  structural_changes: Array<{ field: string; before: unknown; after: unknown }>;
}

/**
 * Per-change graph-data impact. Emitted by `POST /api/schema/migration-preview`
 * for changes whose application would affect existing nodes / edges.
 *
 * `affected` is `null` when the count is unknown (e.g., Neo4j is unavailable
 * or the change kind doesn't have a defined impact query yet) so the UI can
 * distinguish "definitely 0" from "couldn't check".
 */
export interface MigrationImpact {
  kind:
    | 'remove_node_type'
    | 'remove_property'
    | 'remove_relationship_type'
    | 'rel_structural_change'
    | 'change_unique_key'
    | 'add_required_property';
  /** Node-type / relationship-type name the change applies to. */
  target: string;
  /** Property key for property-level changes; undefined otherwise. */
  property?: string;
  /** Human-readable summary, e.g. "Removes property `tier` from Service". */
  summary: string;
  /** Count of affected entities; `null` when unknown. */
  affected: number | null;
  /** Up to 5 sample identifiers (`id` property) for the affected entities. */
  samples: string[];
}

export interface MigrationPreview {
  /** All migrations the proposed YAML would trigger. Empty array = no impact. */
  impacts: MigrationImpact[];
  /** True when one or more impact queries were skipped (Neo4j unavailable). */
  skipped: boolean;
}

/**
 * Body returned by `PUT /api/schema` when the `If-Match` header doesn't match
 * the on-disk content hash — the file changed under the caller. The server's
 * current hash is included so a refetch isn't required to recover.
 */
export interface SchemaVersionConflict {
  error: { code: 'VERSION_CONFLICT'; message: string };
  serverHash: string;
}

export interface SchemaWithHistory {
  current: ShipItSchema;
  history: SchemaSnapshot[];
}
