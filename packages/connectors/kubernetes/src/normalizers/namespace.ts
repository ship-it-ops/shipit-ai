import type { NormalizeOutput, NormalizerContext, RawNamespace } from '../types.js';
import { makeEdge, makeNode } from './claims.js';
import { ids, keys } from './identity.js';

export function labelsToList(labels: Record<string, string> | undefined): string[] {
  return Object.entries(labels ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .sort();
}

export function normalizeNamespace(raw: RawNamespace, ctx: NormalizerContext): NormalizeOutput {
  const name = raw.object.metadata?.name;
  if (!name) return { nodes: [], edges: [], warnings: ['namespace without metadata.name skipped'] };
  const properties = {
    name,
    cluster: ctx.cluster,
    labels: labelsToList(raw.object.metadata?.labels),
  };
  const node = makeNode(
    ids.namespace(ctx.cluster, name),
    'Namespace',
    properties,
    keys.namespace(ctx.cluster, name),
    ctx,
  );
  const partOf = makeEdge('PART_OF', node.id, ids.cluster(ctx.cluster), 1.0, ctx.now);
  return { nodes: [node], edges: [partOf], warnings: [] };
}
