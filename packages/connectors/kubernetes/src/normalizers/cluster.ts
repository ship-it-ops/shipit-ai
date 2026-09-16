import type { NormalizeOutput, NormalizerContext, RawCluster } from '../types.js';
import { compact, makeNode } from './claims.js';
import { ids, keys } from './identity.js';

export function normalizeCluster(raw: RawCluster, ctx: NormalizerContext): NormalizeOutput {
  const properties = compact({
    name: raw.name,
    provider: raw.provider,
    region: raw.region,
    version: raw.version,
  });
  const node = makeNode(ids.cluster(raw.name), 'Cluster', properties, keys.cluster(raw.name), ctx);
  return { nodes: [node], edges: [], warnings: [] };
}
