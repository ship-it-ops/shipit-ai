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
}

export interface SchemaWithHistory {
  current: ShipItSchema;
  history: SchemaSnapshot[];
}
