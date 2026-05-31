// Pure-data subpath for clients that need schema types/utilities without
// dragging the package root barrel (which transitively imports node:fs via
// ./config/loader.ts). See docs/agent/scars/web-ui-cannot-import-mcp-server-root.md.

export { parseSchemaFile } from './parser.js';
export { validateSchema, validateSchemaRelationships } from './validator.js';
export { DEFAULT_SCHEMA } from './defaults.js';
export { DEFAULT_OWNERSHIP_REL_TYPES, getOwnershipRelTypes } from './semantics.js';

export type {
  SchemaMode,
  SchemaPropertyDef,
  SchemaNodeTypeDef,
  SchemaRelTypeDef,
  RelTypeSemantics,
  ShipItSchema,
} from '../types/schema.js';
