import type {
  CanonicalEdge,
  CanonicalEntity,
  CanonicalNode,
  KubernetesMappingConfig,
} from '@shipit-ai/shared';
import { KUBERNETES_WORKLOAD_KINDS } from '@shipit-ai/shared';
import type {
  AuthResult,
  ConnectorConfig,
  ConnectorManifest,
  DiscoveryResult,
  FetchResult,
  ShipItConnector,
  SyncResult,
} from '@shipit-ai/connector-sdk';
import {
  buildKubeConfig,
  classifyError,
  defaultClientFactory,
  KubernetesError,
  parseCredentials,
  type ClientFactory,
  type InClusterProbe,
  type KubeClients,
} from './auth.js';
import { DEFAULT_TIMEOUT_MS, withTimeout } from './fetchers/common.js';
import { fetchClusterSummary } from './fetchers/cluster.js';
import { fetchNamespaceRef, fetchNamespaces } from './fetchers/namespaces.js';
import { WorkloadFetcher } from './fetchers/workloads.js';
import { normalizeCluster } from './normalizers/cluster.js';
import { normalizeNamespace } from './normalizers/namespace.js';
import { normalizeWorkload } from './normalizers/workload.js';
import type {
  NamespaceRef,
  NormalizeOutput,
  NormalizerContext,
  RawRecord,
  WorkloadKind,
} from './types.js';

/** `ConnectorConfig.scope` as the api-server factory builds it (Task 11). */
export interface KubernetesScopeOptions {
  cluster: string;
  namespaces: { include: string[]; exclude: string[] };
  kinds: WorkloadKind[];
  mapping: KubernetesMappingConfig;
  githubOrg: string | null;
  knownRepositories: string[];
  knownTeams: string[];
}

function parseScope(scope: Record<string, unknown>): KubernetesScopeOptions {
  const cluster = typeof scope.cluster === 'string' ? scope.cluster.trim() : '';
  if (!cluster) throw new KubernetesError('SCOPE_INVALID', 'scope.cluster is required');
  if (!scope.mapping || typeof scope.mapping !== 'object')
    throw new KubernetesError('SCOPE_INVALID', 'scope.mapping is required');
  const namespaces =
    (scope.namespaces as { include?: string[]; exclude?: string[] } | undefined) ?? {};
  const kinds = (
    Array.isArray(scope.kinds) && scope.kinds.length > 0
      ? scope.kinds
      : [...KUBERNETES_WORKLOAD_KINDS]
  ) as WorkloadKind[];
  return {
    cluster,
    namespaces: {
      include: namespaces.include ?? ['*'],
      exclude: namespaces.exclude ?? ['kube-system', 'kube-public', 'kube-node-lease'],
    },
    kinds,
    mapping: scope.mapping as KubernetesMappingConfig,
    githubOrg: typeof scope.githubOrg === 'string' && scope.githubOrg ? scope.githubOrg : null,
    knownRepositories: Array.isArray(scope.knownRepositories)
      ? (scope.knownRepositories as string[])
      : [],
    knownTeams: Array.isArray(scope.knownTeams) ? (scope.knownTeams as string[]) : [],
  };
}

export interface KubernetesConnectorOptions {
  timeoutMs?: number;
  inClusterProbe?: InClusterProbe;
}

export class KubernetesConnector implements ShipItConnector {
  readonly manifest: ConnectorManifest = {
    name: 'kubernetes',
    version: '1.0.0',
    schema_version: '1.0',
    min_sdk_version: '0.1.0',
    supported_entity_types: [
      'Cluster',
      'Namespace',
      'Environment',
      'Deployment',
      'BuildArtifact',
      'LogicalService',
    ],
  };

  private readonly clientFactory: ClientFactory;
  private readonly timeoutMs: number;
  private readonly inClusterProbe?: InClusterProbe;
  private clients: KubeClients | null = null;
  private scope: KubernetesScopeOptions | null = null;
  private namespaces: NamespaceRef[] = [];
  private workloadFetcher: WorkloadFetcher | null = null;
  private readonly warnings = new Set<string>();

  constructor(
    clientFactory: ClientFactory = defaultClientFactory,
    options: KubernetesConnectorOptions = {},
  ) {
    this.clientFactory = clientFactory;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.inClusterProbe = options.inClusterProbe;
  }

  /** Non-fatal run problems (e.g. `FORBIDDEN:<kind>`); the scheduler folds them into the run record. */
  getWarnings(): string[] {
    return [...this.warnings];
  }

  async authenticate(config: ConnectorConfig): Promise<AuthResult> {
    try {
      this.scope = parseScope(config.scope);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
    let clients: KubeClients;
    try {
      const kc = buildKubeConfig(parseCredentials(config.credentials), this.inClusterProbe);
      clients = this.clientFactory(kc);
      await withTimeout(clients.version.getCode(), this.timeoutMs, 'GET /version');
    } catch (err) {
      return { success: false, error: classifyError(err).message };
    }
    this.clients = clients;
    this.namespaces = [];
    this.workloadFetcher = null;
    this.warnings.clear();
    return { success: true };
  }

  async discover(): Promise<DiscoveryResult> {
    // Order matters: namespaces (and their environments) publish before workloads.
    return { entity_types: ['Cluster', 'Namespace', 'Workload'], total_entities: {} };
  }

  async fetch(entityType: string, cursor?: string): Promise<FetchResult> {
    const clients = this.requireClients();
    const scope = this.requireScope();
    try {
      switch (entityType) {
        case 'Cluster':
          return {
            entities: [await fetchClusterSummary(clients, scope.cluster, this.timeoutMs)],
            has_more: false,
          };
        case 'Namespace': {
          const page = await fetchNamespaces(clients, scope.namespaces, cursor, this.timeoutMs);
          if (!cursor) this.namespaces = [];
          this.namespaces.push(...page.refs);
          return { entities: page.entities, cursor: page.cursor, has_more: page.has_more };
        }
        case 'Workload': {
          if (this.namespaces.length === 0) {
            throw new KubernetesError(
              'NAMESPACE_SCOPE_EMPTY',
              'no namespaces matched scope.namespaces.include/exclude (or Namespace was not fetched first)',
            );
          }
          if (!this.workloadFetcher) {
            this.workloadFetcher = new WorkloadFetcher(
              clients,
              this.namespaces,
              scope.kinds,
              this.timeoutMs,
            );
          }
          const result = await this.workloadFetcher.fetch(cursor);
          for (const w of this.workloadFetcher.warnings.splice(0)) this.warnings.add(w);
          return result;
        }
        default:
          return { entities: [], has_more: false };
      }
    } catch (err) {
      // The harness sniffs `status` (401/403) to mark the instance degraded.
      throw classifyError(err);
    }
  }

  normalize(raw: unknown[]): CanonicalEntity {
    const ctx = this.normalizerContext();
    const nodes = new Map<string, CanonicalNode>();
    const edges = new Map<string, CanonicalEdge>();
    for (const record of raw as RawRecord[]) {
      let out: NormalizeOutput;
      switch (record.__shipit) {
        case 'cluster':
          out = normalizeCluster(record, ctx);
          break;
        case 'namespace':
          out = normalizeNamespace(record, ctx);
          break;
        case 'workload':
          out = normalizeWorkload(record, ctx);
          break;
        default:
          continue;
      }
      for (const n of out.nodes) if (!nodes.has(n.id)) nodes.set(n.id, n);
      for (const e of out.edges) {
        // Several workloads of one LogicalService may link the same Repository
        // at different confidences (annotation 1.0 on one, app-label 0.6 on
        // another). mergeEdge is last-writer-wins, so keep the best per
        // (type, from, to) within a batch.
        const key = `${e.type}|${e.from}|${e.to}`;
        const prev = edges.get(key);
        if (!prev || e._confidence > prev._confidence) edges.set(key, e);
      }
      for (const w of out.warnings) this.warnings.add(w);
    }
    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }

  /**
   * Refetch seam for a later watch/webhook layer: one workload through the same normalize().
   * Not found ⇒ empty entity; the absence sweep handles deletions.
   */
  async refetchWorkload(
    namespace: string,
    kind: WorkloadKind,
    name: string,
  ): Promise<CanonicalEntity> {
    const clients = this.requireClients();
    try {
      const ref =
        this.namespaces.find((n) => n.name === namespace) ??
        (await fetchNamespaceRef(clients, namespace, this.timeoutMs));
      const fetcher = new WorkloadFetcher(clients, [ref], [kind], this.timeoutMs);
      const raw = await fetcher.fetchOne(name);
      return raw ? this.normalize([raw]) : { nodes: [], edges: [] };
    } catch (err) {
      throw classifyError(err);
    }
  }

  async sync(mode: 'full' | 'incremental'): Promise<SyncResult> {
    void mode; // every Kubernetes run is a full list
    const startTime = Date.now();
    let entitiesSynced = 0;
    const errors: string[] = [];
    try {
      for (const entityType of (await this.discover()).entity_types) {
        let cursor: string | undefined;
        let hasMore = true;
        while (hasMore) {
          const result = await this.fetch(entityType, cursor);
          entitiesSynced += result.entities.length;
          cursor = result.cursor;
          hasMore = result.has_more;
        }
      }
      return {
        status: errors.length > 0 ? 'partial' : 'success',
        entities_synced: entitiesSynced,
        errors,
        duration_ms: Date.now() - startTime,
      };
    } catch (err) {
      return {
        status: 'failed',
        entities_synced: entitiesSynced,
        errors: [(err as Error).message],
        duration_ms: Date.now() - startTime,
      };
    }
  }

  private requireClients(): KubeClients {
    if (!this.clients) throw new Error('Not authenticated. Call authenticate() first.');
    return this.clients;
  }

  private requireScope(): KubernetesScopeOptions {
    if (!this.scope) throw new Error('Not authenticated. Call authenticate() first.');
    return this.scope;
  }

  private normalizerContext(): NormalizerContext {
    const scope = this.requireScope();
    return {
      cluster: scope.cluster,
      mapping: scope.mapping,
      githubOrg: scope.githubOrg,
      knownRepositories: scope.knownRepositories,
      knownTeams: scope.knownTeams,
      // Stamped per normalize() call so `_last_synced` is always after the run's startedAt.
      now: new Date().toISOString(),
    };
  }
}
