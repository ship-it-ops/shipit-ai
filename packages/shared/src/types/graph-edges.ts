/**
 * Relationship-type patterns used to traverse the graph, as Cypher alternation
 * strings (`A|B|C`).
 *
 * These live in `shared` rather than beside the query generator that consumes
 * them because two packages must agree on the list: `mcp-server` builds the
 * blast-radius query from them, and `core-writer`'s cross-source acceptance
 * test asserts what that traversal reaches. When the test kept its own copy,
 * adding a relationship type to the generator could not fail any test — the
 * copy simply drifted.
 *
 * Adding a dependency edge type? Add it here and both sides move together.
 */

/**
 * Edges along which impact propagates. Undirected traversal is safe here: these
 * are "X is realised by / depends on Y" relationships, so reaching Y from X or
 * X from Y both describe a real blast-radius relationship.
 */
export const DEPENDENCY_EDGE_PATTERN =
  'IMPLEMENTED_BY|DEPLOYED_AS|EMITS_TELEMETRY_AS|CALLS|DEPENDS_ON|BUILT_BY|TRIGGERS';

/**
 * Ownership edges are DIRECTIONAL: an owner (Team/Person) points at what it
 * owns. Traversed downstream only, so a Team reaches its owned repos and
 * services (GitHub teams own repos via CODEOWNER_OF, not OWNS), and excluded
 * upstream so a service's blast radius does not surface its owning team.
 */
export const OWNERSHIP_EDGE_PATTERN = 'OWNS|CODEOWNER_OF';
