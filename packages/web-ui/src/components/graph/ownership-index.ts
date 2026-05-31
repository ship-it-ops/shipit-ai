import type { GraphData } from '@/lib/api';

/**
 * Map of node id → set of owner names that own that node. Drives the
 * Owner facet on the graph explorer. Build once per `(data, ownershipRelTypes)`
 * change; consumers can then answer "does node X pass the owner filter?" with
 * a single `Set.has` lookup per selected owner.
 */
export type OwnershipIndex = Map<string, Set<string>>;

/**
 * Build an ownership index from a graph payload, treating any edge whose
 * `type` appears in `ownershipRelTypes` as conferring ownership of its target
 * from the source node's `name`. Also folds in two non-edge sources:
 *   - `node.data.owner` (string) for seeded LogicalServices that carry the
 *     legacy flat owner property.
 *   - `Team`/`Person` nodes themselves — they own themselves, so selecting
 *     "platform-team" in the filter keeps the platform-team node visible.
 *
 * Pure function: no Cytoscape, no React, easy to test.
 */
export function buildOwnershipIndex(
  data: GraphData | undefined,
  ownershipRelTypes: ReadonlySet<string>,
): OwnershipIndex {
  const out: OwnershipIndex = new Map();
  if (!data) return out;

  const nodeById = new Map<string, GraphData['nodes'][number]['data']>();
  for (const node of data.nodes) {
    nodeById.set(node.data.id, node.data);
  }

  const record = (nodeId: string, owner: string) => {
    let set = out.get(nodeId);
    if (!set) {
      set = new Set();
      out.set(nodeId, set);
    }
    set.add(owner);
  };

  for (const node of data.nodes) {
    const d = node.data;
    if (typeof d.owner === 'string' && d.owner) record(d.id, d.owner);
    if ((d.type === 'Team' || d.type === 'Person') && typeof d.name === 'string' && d.name) {
      record(d.id, d.name);
    }
  }

  for (const edge of data.edges) {
    if (!ownershipRelTypes.has(edge.data.type)) continue;
    const source = nodeById.get(edge.data.source);
    if (!source) continue;
    const sourceName = typeof source.name === 'string' ? source.name : '';
    if (sourceName) record(edge.data.target, sourceName);
  }

  return out;
}
