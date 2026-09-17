// Reference cross-source fixture: one GitHub org (repo + team) and one cluster
// (namespace + three workloads) shaped like the real demo chart. Used by the
// acceptance test below; keep it small and literal.
import type { GitHubRepo, GitHubTeam } from '@shipit-ai/connector-github';
import type {
  NamespaceRef,
  NormalizerContext,
  RawCluster,
  RawNamespace,
  RawWorkload,
} from '@shipit-ai/connector-kubernetes';
import { EMPTY_POD_SUMMARY } from '@shipit-ai/connector-kubernetes';
import { KUBERNETES_DEFAULT_MAPPING } from '@shipit-ai/shared';

export const GITHUB_ORG = 'Ship-It-Ops';
export const GITHUB_CONNECTOR = 'gh-ship-it-ops';
export const K8S_CONNECTOR = 'k8s-demo';
export const CLUSTER = 'shipit-demo';

export const REPO_ID = 'shipit://repository/default/Ship-It-Ops/ShipIt-AI';
export const TEAM_ID = 'shipit://team/default/Ship-It-Ops/platform-team';
export const SERVICE_ID = 'shipit://logical-service/default/shipit-ai';
export const API_SERVER_ID = 'shipit://deployment/default/shipit-demo/shipit/deployment/api-server';
export const WEB_UI_ID = 'shipit://deployment/default/shipit-demo/shipit/deployment/web-ui';
export const REDIS_ID = 'shipit://deployment/default/shipit-demo/shipit/statefulset/redis';
export const WEB_UI_ARTIFACT_ID =
  'shipit://build-artifact/default/us-central1-docker.pkg.dev/ship-it-ai-portal/shipit-ai/web-ui@sha-97189de';
export const ALL_DEPLOYMENTS = Object.freeze([API_SERVER_ID, REDIS_ID, WEB_UI_ID].sort());

export const referenceRepo: GitHubRepo = {
  name: 'ShipIt-AI',
  full_name: 'Ship-It-Ops/ShipIt-AI',
  html_url: 'https://github.com/Ship-It-Ops/ShipIt-AI',
  default_branch: 'main',
  visibility: 'public',
  language: 'TypeScript',
  topics: ['knowledge-graph'],
  archived: false,
  description: 'AI-ready knowledge graph builder',
  updated_at: '2026-09-16T00:00:00Z',
  pushed_at: '2026-09-16T00:00:00Z',
};

export const referenceTeam: GitHubTeam = {
  slug: 'platform-team',
  name: 'Platform Team',
  description: null,
  privacy: 'closed',
  html_url: 'https://github.com/orgs/Ship-It-Ops/teams/platform-team',
  members: [
    {
      login: 'mohamed-e',
      avatar_url: '',
      html_url: 'https://github.com/mohamed-e',
      role: 'maintainer',
    },
  ],
};

export const referenceCluster: RawCluster = {
  __shipit: 'cluster',
  name: CLUSTER,
  version: 'v1.31.2-gke.1',
  provider: 'gcp',
  region: 'us-central1',
};

const namespaceRef: NamespaceRef = {
  name: 'shipit',
  labels: { environment: 'production', team: 'Platform Team' },
  annotations: {},
};

export const referenceNamespace: RawNamespace = {
  __shipit: 'namespace',
  object: { metadata: { name: 'shipit', labels: namespaceRef.labels } },
};

const chartLabels = (component: string) => ({
  'app.kubernetes.io/name': 'shipit-ai',
  'app.kubernetes.io/instance': 'shipit',
  'app.kubernetes.io/component': component,
});

function deployment(
  name: string,
  image: string,
  annotations: Record<string, string> = {},
): RawWorkload {
  return {
    __shipit: 'workload',
    kind: 'Deployment',
    namespace: namespaceRef,
    pods: EMPTY_POD_SUMMARY,
    object: {
      metadata: { name, namespace: 'shipit', labels: chartLabels(name), annotations },
      spec: {
        replicas: 1,
        selector: { matchLabels: chartLabels(name) },
        template: { spec: { containers: [{ name, image }] } },
      },
      status: {
        replicas: 1,
        readyReplicas: 1,
        conditions: [{ type: 'Available', status: 'True' }],
      },
    },
  };
}

export const referenceWorkloads: RawWorkload[] = [
  deployment(
    'api-server',
    'us-central1-docker.pkg.dev/ship-it-ai-portal/shipit-ai/api-server:sha-97189de',
    { 'shipit.ai/github-repo': 'Ship-It-Ops/ShipIt-AI' },
  ),
  deployment('web-ui', 'us-central1-docker.pkg.dev/ship-it-ai-portal/shipit-ai/web-ui:sha-97189de'),
  {
    __shipit: 'workload',
    kind: 'StatefulSet',
    namespace: namespaceRef,
    pods: EMPTY_POD_SUMMARY,
    object: {
      metadata: { name: 'redis', namespace: 'shipit', labels: chartLabels('redis') },
      spec: {
        replicas: 1,
        serviceName: 'redis',
        selector: { matchLabels: chartLabels('redis') },
        template: { spec: { containers: [{ name: 'redis', image: 'redis:7-alpine' }] } },
      },
      status: { replicas: 1, readyReplicas: 1 },
    },
  },
];

export function contextAt(now: string): NormalizerContext {
  return {
    cluster: CLUSTER,
    mapping: KUBERNETES_DEFAULT_MAPPING,
    githubOrg: GITHUB_ORG,
    knownRepositories: ['ShipIt-AI'],
    knownTeams: ['platform-team'],
    now,
  };
}
