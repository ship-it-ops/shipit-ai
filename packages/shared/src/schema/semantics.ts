import type { ShipItSchema } from '../types/schema.js';

/**
 * Fallback set used by clients before the schema API has loaded, or when it
 * is unreachable. Matches the rel types marked `semantics: 'ownership'` in
 * `DEFAULT_SCHEMA` so behavior is identical until a custom schema arrives.
 */
export const DEFAULT_OWNERSHIP_REL_TYPES: ReadonlySet<string> = new Set(['CODEOWNER_OF', 'OWNS']);

/**
 * Returns the set of relationship-type names that the schema marks as
 * ownership relationships. The graph UI uses this to drive the Owner filter
 * without hardcoding edge-type strings — when a new connector adds a rel
 * type tagged `semantics: 'ownership'`, the filter picks it up automatically.
 */
export function getOwnershipRelTypes(schema: ShipItSchema): Set<string> {
  const out = new Set<string>();
  for (const [name, def] of Object.entries(schema.relationship_types)) {
    if (def.semantics === 'ownership') out.add(name);
  }
  return out;
}
