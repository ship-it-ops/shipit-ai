import type { KubeClients } from '../auth.js';
import type { RawCluster } from '../types.js';
import { DEFAULT_TIMEOUT_MS, withTimeout } from './common.js';

export function providerFromId(providerId: string | undefined): string | undefined {
  if (!providerId) return undefined;
  const scheme = providerId.split('://')[0];
  switch (scheme) {
    case 'gce':
      return 'gcp';
    case 'aws':
      return 'aws';
    case 'azure':
      return 'azure';
    default:
      return scheme || undefined;
  }
}

/** One record per run. Version is required (authenticate already proved it); nodes are optional. */
export async function fetchClusterSummary(
  clients: KubeClients,
  clusterName: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RawCluster> {
  const version = await withTimeout(clients.version.getCode(), timeoutMs, 'GET /version');
  const raw: RawCluster = { __shipit: 'cluster', name: clusterName };
  if (version.gitVersion) raw.version = version.gitVersion;
  try {
    // Bounded probe of the first node only; `_continue` is intentionally not
    // threaded because only `items[0]` is ever read below.
    const nodes = await withTimeout(clients.core.listNode({ limit: 1 }), timeoutMs, 'list nodes');
    const first = nodes.items[0];
    if (first) {
      const provider = providerFromId(first.spec?.providerID);
      if (provider) raw.provider = provider;
      const labels = first.metadata?.labels ?? {};
      const region =
        labels['topology.kubernetes.io/region'] ??
        labels['failure-domain.beta.kubernetes.io/region'];
      if (region) raw.region = region;
    }
  } catch {
    // RBAC may deny `list nodes`; provider/region simply stay unset.
  }
  return raw;
}
