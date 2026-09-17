import type { V1CronJob, V1DaemonSet, V1Deployment, V1StatefulSet } from '@kubernetes/client-node';
import type {
  NamespaceRef,
  NormalizerContext,
  PodSummary,
  RawWorkload,
  WorkloadKind,
  WorkloadObject,
} from '../../types.js';
import { EMPTY_POD_SUMMARY } from '../../types.js';

export const CLUSTER = 'shipit-demo';
export const NOW = '2026-09-16T12:00:00.000Z';

export const demoNamespace: NamespaceRef = {
  name: 'shipit',
  labels: { environment: 'production', team: 'Platform Team' },
  annotations: {},
};

export const apiServerDeployment: V1Deployment = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: {
    name: 'api-server',
    namespace: 'shipit',
    uid: 'uid-api-server',
    creationTimestamp: new Date('2026-06-10T08:00:00.000Z'),
    labels: {
      'app.kubernetes.io/name': 'shipit-ai',
      'app.kubernetes.io/instance': 'shipit',
      'app.kubernetes.io/component': 'api-server',
      'app.kubernetes.io/managed-by': 'Helm',
      'helm.sh/chart': 'shipit-ai-0.1.0',
    },
    annotations: { 'shipit.ai/github-repo': 'Ship-It-Ops/ShipIt-AI' },
  },
  spec: {
    replicas: 2,
    selector: { matchLabels: { 'app.kubernetes.io/component': 'api-server' } },
    template: {
      spec: {
        containers: [
          {
            name: 'api-server',
            image: 'us-central1-docker.pkg.dev/ship-it-ai-portal/shipit-ai/api-server:sha-97189de',
          },
        ],
      },
    },
  },
  status: {
    replicas: 2,
    readyReplicas: 2,
    conditions: [
      { type: 'Available', status: 'True' },
      { type: 'Progressing', status: 'True' },
    ],
  },
};

export const apiServerPods: PodSummary = {
  readyPods: 2,
  restarts: 3,
  imageDigests: {
    'api-server': 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
};

export const redisStatefulSet: V1StatefulSet = {
  apiVersion: 'apps/v1',
  kind: 'StatefulSet',
  metadata: {
    name: 'redis',
    namespace: 'shipit',
    labels: {
      'app.kubernetes.io/name': 'shipit-ai',
      'app.kubernetes.io/instance': 'shipit',
      'app.kubernetes.io/component': 'redis',
    },
  },
  spec: {
    replicas: 1,
    serviceName: 'redis',
    selector: { matchLabels: { 'app.kubernetes.io/component': 'redis' } },
    template: { spec: { containers: [{ name: 'redis', image: 'redis:7-alpine' }] } },
  },
  status: { replicas: 1, readyReplicas: 1 },
};

export const nodeExporterDaemonSet: V1DaemonSet = {
  apiVersion: 'apps/v1',
  kind: 'DaemonSet',
  metadata: { name: 'node-exporter', namespace: 'monitoring', labels: {} },
  spec: {
    selector: { matchLabels: { app: 'node-exporter' } },
    template: {
      spec: {
        containers: [{ name: 'exporter', image: 'quay.io/prometheus/node-exporter:v1.8.1' }],
      },
    },
  },
  status: {
    currentNumberScheduled: 3,
    desiredNumberScheduled: 3,
    numberMisscheduled: 0,
    numberReady: 2,
  },
};

export const backupCronJob: V1CronJob = {
  apiVersion: 'batch/v1',
  kind: 'CronJob',
  metadata: {
    name: 'neo4j-backup',
    namespace: 'shipit',
    labels: { 'app.kubernetes.io/name': 'shipit-ai' },
  },
  spec: {
    schedule: '0 3 * * *',
    suspend: true,
    jobTemplate: {
      spec: {
        template: {
          spec: { containers: [{ name: 'backup', image: 'ghcr.io/acme/backup:1.2.3' }] },
        },
      },
    },
  },
};

export const demoContext: NormalizerContext = {
  cluster: CLUSTER,
  mapping: {
    service: { nameFrom: ['part-of', 'name', 'workload'], includeComponent: false },
    environment: {
      label: 'environment',
      namespaceRules: [
        { pattern: '^(prod|production)', environment: 'production' },
        { pattern: '^(stag|staging)', environment: 'staging' },
        { pattern: '^(dev|development)', environment: 'development' },
      ],
      default: null,
    },
    ownership: { teamLabel: 'team' },
    repoLink: { annotation: 'shipit.ai/github-repo', githubOrg: null, nameMatch: true },
  },
  githubOrg: 'Ship-It-Ops',
  knownRepositories: ['ShipIt-AI'],
  knownTeams: ['platform-team'],
  now: NOW,
};

export function rawWorkload(
  kind: WorkloadKind,
  object: WorkloadObject,
  pods: PodSummary = EMPTY_POD_SUMMARY,
  namespace: NamespaceRef = demoNamespace,
): RawWorkload {
  return { __shipit: 'workload', kind, object, namespace, pods };
}
