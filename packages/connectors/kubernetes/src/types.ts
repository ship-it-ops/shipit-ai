import type {
  V1CronJob,
  V1DaemonSet,
  V1Deployment,
  V1Namespace,
  V1StatefulSet,
} from '@kubernetes/client-node';
import type {
  CanonicalEdge,
  CanonicalNode,
  KubernetesMappingConfig,
  KubernetesWorkloadKind,
} from '@shipit-ai/shared';

export type WorkloadKind = KubernetesWorkloadKind;
export type WorkloadObject = V1Deployment | V1StatefulSet | V1DaemonSet | V1CronJob;

/** Cluster summary assembled by fetchers/cluster.ts (one per run). */
export interface RawCluster {
  __shipit: 'cluster';
  name: string;
  version?: string;
  provider?: string;
  region?: string;
}

export interface RawNamespace {
  __shipit: 'namespace';
  object: V1Namespace;
}

/** What the workload normalizer needs to know about the enclosing namespace. */
export interface NamespaceRef {
  name: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

/** Per-workload rollup of its pods (one pod list per namespace, matched in memory). */
export interface PodSummary {
  readyPods: number;
  restarts: number;
  /** container name → image digest (`sha256:…`) from `status.containerStatuses[].imageID`. */
  imageDigests: Record<string, string>;
}

export const EMPTY_POD_SUMMARY: PodSummary = { readyPods: 0, restarts: 0, imageDigests: {} };

export interface RawWorkload {
  __shipit: 'workload';
  kind: WorkloadKind;
  object: WorkloadObject;
  namespace: NamespaceRef;
  pods: PodSummary;
}

/** Every record `fetch()` hands to `normalize()`; `__shipit` is the dispatch key. */
export type RawRecord = RawCluster | RawNamespace | RawWorkload;

export interface NormalizerContext {
  cluster: string;
  mapping: KubernetesMappingConfig;
  /** Resolved GitHub org for predicted Repository/Team ids; null disables name tiers. */
  githubOrg: string | null;
  /** Repository names (source casing) already in the graph for `githubOrg`. */
  knownRepositories: string[];
  /** Team slugs already in the graph for `githubOrg`. */
  knownTeams: string[];
  /** ISO timestamp used for `_last_synced` / claim `ingested_at` of this normalize() call. */
  now: string;
}

export interface NormalizeOutput {
  nodes: CanonicalNode[];
  edges: CanonicalEdge[];
  warnings: string[];
}
