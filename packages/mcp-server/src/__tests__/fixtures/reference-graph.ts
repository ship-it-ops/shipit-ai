export interface GraphNode {
  id: string;
  label: string;
  properties: Record<string, unknown>;
}

export interface GraphEdge {
  type: string;
  from: string;
  to: string;
  properties?: Record<string, unknown>;
}

export interface ReferenceGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export const REFERENCE_GRAPH: ReferenceGraph = {
  nodes: [
    // LogicalServices (5)
    {
      id: 'shipit://logical-service/default/graph-api',
      label: 'LogicalService',
      properties: {
        name: 'graph-api',
        tier_effective: 1,
        owner_effective: 'api-team',
        lifecycle_effective: 'production',
      },
    },
    {
      id: 'shipit://logical-service/default/config-service',
      label: 'LogicalService',
      properties: {
        name: 'config-service',
        tier_effective: 2,
        owner_effective: 'platform-team',
        lifecycle_effective: 'production',
      },
    },
    {
      id: 'shipit://logical-service/default/claim-store',
      label: 'LogicalService',
      properties: {
        name: 'claim-store',
        tier_effective: 1,
        owner_effective: 'api-team',
        lifecycle_effective: 'production',
      },
    },
    {
      id: 'shipit://logical-service/default/connector-runtime',
      label: 'LogicalService',
      properties: {
        name: 'connector-runtime',
        tier_effective: 2,
        owner_effective: 'ai-team',
        lifecycle_effective: 'production',
      },
    },
    {
      id: 'shipit://logical-service/default/auth-service',
      label: 'LogicalService',
      properties: {
        name: 'auth-service',
        tier_effective: 2,
        owner_effective: 'platform-team',
        lifecycle_effective: 'production',
      },
    },

    // Repositories (5)
    {
      id: 'shipit://repository/default/graph-api',
      label: 'Repository',
      properties: { name: 'graph-api', url: 'https://github.com/shipitops/graph-api' },
    },
    {
      id: 'shipit://repository/default/config-service',
      label: 'Repository',
      properties: { name: 'config-service', url: 'https://github.com/shipitops/config-service' },
    },
    {
      id: 'shipit://repository/default/claim-store',
      label: 'Repository',
      properties: { name: 'claim-store', url: 'https://github.com/shipitops/claim-store' },
    },
    {
      id: 'shipit://repository/default/connector-runtime',
      label: 'Repository',
      properties: {
        name: 'connector-runtime',
        url: 'https://github.com/shipitops/connector-runtime',
      },
    },
    {
      id: 'shipit://repository/default/auth-service',
      label: 'Repository',
      properties: { name: 'auth-service', url: 'https://github.com/shipitops/auth-service' },
    },

    // Deployments (10: 2 per service: staging + prod)
    {
      id: 'shipit://deployment/default/graph-api-prod',
      label: 'Deployment',
      properties: { name: 'graph-api-prod', environment: 'production', replicas: 3 },
    },
    {
      id: 'shipit://deployment/default/graph-api-staging',
      label: 'Deployment',
      properties: { name: 'graph-api-staging', environment: 'staging', replicas: 1 },
    },
    {
      id: 'shipit://deployment/default/config-service-prod',
      label: 'Deployment',
      properties: { name: 'config-service-prod', environment: 'production', replicas: 2 },
    },
    {
      id: 'shipit://deployment/default/config-service-staging',
      label: 'Deployment',
      properties: { name: 'config-service-staging', environment: 'staging', replicas: 1 },
    },
    {
      id: 'shipit://deployment/default/claim-store-prod',
      label: 'Deployment',
      properties: { name: 'claim-store-prod', environment: 'production', replicas: 3 },
    },
    {
      id: 'shipit://deployment/default/claim-store-staging',
      label: 'Deployment',
      properties: { name: 'claim-store-staging', environment: 'staging', replicas: 1 },
    },
    {
      id: 'shipit://deployment/default/connector-runtime-prod',
      label: 'Deployment',
      properties: { name: 'connector-runtime-prod', environment: 'production', replicas: 2 },
    },
    {
      id: 'shipit://deployment/default/connector-runtime-staging',
      label: 'Deployment',
      properties: { name: 'connector-runtime-staging', environment: 'staging', replicas: 1 },
    },
    {
      id: 'shipit://deployment/default/auth-service-prod',
      label: 'Deployment',
      properties: { name: 'auth-service-prod', environment: 'production', replicas: 2 },
    },
    {
      id: 'shipit://deployment/default/auth-service-staging',
      label: 'Deployment',
      properties: { name: 'auth-service-staging', environment: 'staging', replicas: 1 },
    },

    // RuntimeServices (5)
    {
      id: 'shipit://runtime-service/default/graph-api-runtime',
      label: 'RuntimeService',
      properties: { name: 'graph-api-runtime' },
    },
    {
      id: 'shipit://runtime-service/default/config-service-runtime',
      label: 'RuntimeService',
      properties: { name: 'config-service-runtime' },
    },
    {
      id: 'shipit://runtime-service/default/claim-store-runtime',
      label: 'RuntimeService',
      properties: { name: 'claim-store-runtime' },
    },
    {
      id: 'shipit://runtime-service/default/connector-runtime-runtime',
      label: 'RuntimeService',
      properties: { name: 'connector-runtime-runtime' },
    },
    {
      id: 'shipit://runtime-service/default/auth-service-runtime',
      label: 'RuntimeService',
      properties: { name: 'auth-service-runtime' },
    },

    // Teams (3)
    {
      id: 'shipit://team/default/api-team',
      label: 'Team',
      properties: { name: 'api-team', email: 'api@shipitops.com' },
    },
    {
      id: 'shipit://team/default/platform-team',
      label: 'Team',
      properties: { name: 'platform-team', email: 'platform@shipitops.com' },
    },
    {
      id: 'shipit://team/default/ai-team',
      label: 'Team',
      properties: { name: 'ai-team', email: 'ai@shipitops.com' },
    },

    // Persons (8)
    {
      id: 'shipit://person/default/alice',
      label: 'Person',
      properties: { name: 'Alice Smith', email: 'alice@shipitops.com' },
    },
    {
      id: 'shipit://person/default/bob',
      label: 'Person',
      properties: { name: 'Bob Jones', email: 'bob@shipitops.com' },
    },
    {
      id: 'shipit://person/default/charlie',
      label: 'Person',
      properties: { name: 'Charlie Brown', email: 'charlie@shipitops.com' },
    },
    {
      id: 'shipit://person/default/diana',
      label: 'Person',
      properties: { name: 'Diana Prince', email: 'diana@shipitops.com' },
    },
    {
      id: 'shipit://person/default/eve',
      label: 'Person',
      properties: { name: 'Eve Wilson', email: 'eve@shipitops.com' },
    },
    {
      id: 'shipit://person/default/frank',
      label: 'Person',
      properties: { name: 'Frank Castle', email: 'frank@shipitops.com' },
    },
    {
      id: 'shipit://person/default/grace',
      label: 'Person',
      properties: { name: 'Grace Hopper', email: 'grace@shipitops.com' },
    },
    {
      id: 'shipit://person/default/hank',
      label: 'Person',
      properties: { name: 'Hank Pym', email: 'hank@shipitops.com' },
    },

    // Pipelines (3)
    {
      id: 'shipit://pipeline/default/graph-api-ci',
      label: 'Pipeline',
      properties: { name: 'graph-api-ci', type: 'CI/CD' },
    },
    {
      id: 'shipit://pipeline/default/config-service-ci',
      label: 'Pipeline',
      properties: { name: 'config-service-ci', type: 'CI/CD' },
    },
    {
      id: 'shipit://pipeline/default/connector-runtime-ci',
      label: 'Pipeline',
      properties: { name: 'connector-runtime-ci', type: 'CI/CD' },
    },

    // Monitors (2)
    {
      id: 'shipit://monitor/default/graph-api-latency',
      label: 'Monitor',
      properties: { name: 'graph-api-latency', status: 'OK' },
    },
    {
      id: 'shipit://monitor/default/graph-api-error-rate',
      label: 'Monitor',
      properties: { name: 'graph-api-error-rate', status: 'OK' },
    },
  ],

  edges: [
    // IMPLEMENTED_BY: LogicalService -> Repository
    {
      type: 'IMPLEMENTED_BY',
      from: 'shipit://logical-service/default/graph-api',
      to: 'shipit://repository/default/graph-api',
    },
    {
      type: 'IMPLEMENTED_BY',
      from: 'shipit://logical-service/default/config-service',
      to: 'shipit://repository/default/config-service',
    },
    {
      type: 'IMPLEMENTED_BY',
      from: 'shipit://logical-service/default/claim-store',
      to: 'shipit://repository/default/claim-store',
    },
    {
      type: 'IMPLEMENTED_BY',
      from: 'shipit://logical-service/default/connector-runtime',
      to: 'shipit://repository/default/connector-runtime',
    },
    {
      type: 'IMPLEMENTED_BY',
      from: 'shipit://logical-service/default/auth-service',
      to: 'shipit://repository/default/auth-service',
    },

    // DEPLOYED_AS: LogicalService -> Deployment
    {
      type: 'DEPLOYED_AS',
      from: 'shipit://logical-service/default/graph-api',
      to: 'shipit://deployment/default/graph-api-prod',
    },
    {
      type: 'DEPLOYED_AS',
      from: 'shipit://logical-service/default/graph-api',
      to: 'shipit://deployment/default/graph-api-staging',
    },
    {
      type: 'DEPLOYED_AS',
      from: 'shipit://logical-service/default/config-service',
      to: 'shipit://deployment/default/config-service-prod',
    },
    {
      type: 'DEPLOYED_AS',
      from: 'shipit://logical-service/default/config-service',
      to: 'shipit://deployment/default/config-service-staging',
    },
    {
      type: 'DEPLOYED_AS',
      from: 'shipit://logical-service/default/claim-store',
      to: 'shipit://deployment/default/claim-store-prod',
    },
    {
      type: 'DEPLOYED_AS',
      from: 'shipit://logical-service/default/claim-store',
      to: 'shipit://deployment/default/claim-store-staging',
    },
    {
      type: 'DEPLOYED_AS',
      from: 'shipit://logical-service/default/connector-runtime',
      to: 'shipit://deployment/default/connector-runtime-prod',
    },
    {
      type: 'DEPLOYED_AS',
      from: 'shipit://logical-service/default/connector-runtime',
      to: 'shipit://deployment/default/connector-runtime-staging',
    },
    {
      type: 'DEPLOYED_AS',
      from: 'shipit://logical-service/default/auth-service',
      to: 'shipit://deployment/default/auth-service-prod',
    },
    {
      type: 'DEPLOYED_AS',
      from: 'shipit://logical-service/default/auth-service',
      to: 'shipit://deployment/default/auth-service-staging',
    },

    // EMITS_TELEMETRY_AS: LogicalService -> RuntimeService
    {
      type: 'EMITS_TELEMETRY_AS',
      from: 'shipit://logical-service/default/graph-api',
      to: 'shipit://runtime-service/default/graph-api-runtime',
    },
    {
      type: 'EMITS_TELEMETRY_AS',
      from: 'shipit://logical-service/default/config-service',
      to: 'shipit://runtime-service/default/config-service-runtime',
    },
    {
      type: 'EMITS_TELEMETRY_AS',
      from: 'shipit://logical-service/default/claim-store',
      to: 'shipit://runtime-service/default/claim-store-runtime',
    },
    {
      type: 'EMITS_TELEMETRY_AS',
      from: 'shipit://logical-service/default/connector-runtime',
      to: 'shipit://runtime-service/default/connector-runtime-runtime',
    },
    {
      type: 'EMITS_TELEMETRY_AS',
      from: 'shipit://logical-service/default/auth-service',
      to: 'shipit://runtime-service/default/auth-service-runtime',
    },

    // DEPENDS_ON: LogicalService -> LogicalService
    {
      type: 'DEPENDS_ON',
      from: 'shipit://logical-service/default/graph-api',
      to: 'shipit://logical-service/default/config-service',
    },
    {
      type: 'DEPENDS_ON',
      from: 'shipit://logical-service/default/graph-api',
      to: 'shipit://logical-service/default/auth-service',
    },
    {
      type: 'DEPENDS_ON',
      from: 'shipit://logical-service/default/claim-store',
      to: 'shipit://logical-service/default/config-service',
    },
    {
      type: 'DEPENDS_ON',
      from: 'shipit://logical-service/default/connector-runtime',
      to: 'shipit://logical-service/default/graph-api',
    },
    {
      type: 'DEPENDS_ON',
      from: 'shipit://logical-service/default/connector-runtime',
      to: 'shipit://logical-service/default/auth-service',
    },

    // CALLS: RuntimeService -> RuntimeService
    {
      type: 'CALLS',
      from: 'shipit://runtime-service/default/graph-api-runtime',
      to: 'shipit://runtime-service/default/config-service-runtime',
    },
    {
      type: 'CALLS',
      from: 'shipit://runtime-service/default/connector-runtime-runtime',
      to: 'shipit://runtime-service/default/graph-api-runtime',
    },

    // OWNS: Team -> LogicalService
    {
      type: 'OWNS',
      from: 'shipit://team/default/api-team',
      to: 'shipit://logical-service/default/graph-api',
    },
    {
      type: 'OWNS',
      from: 'shipit://team/default/api-team',
      to: 'shipit://logical-service/default/claim-store',
    },
    {
      type: 'OWNS',
      from: 'shipit://team/default/platform-team',
      to: 'shipit://logical-service/default/config-service',
    },
    {
      type: 'OWNS',
      from: 'shipit://team/default/platform-team',
      to: 'shipit://logical-service/default/auth-service',
    },
    {
      type: 'OWNS',
      from: 'shipit://team/default/ai-team',
      to: 'shipit://logical-service/default/connector-runtime',
    },

    // MEMBER_OF: Person -> Team
    {
      type: 'MEMBER_OF',
      from: 'shipit://person/default/alice',
      to: 'shipit://team/default/api-team',
    },
    {
      type: 'MEMBER_OF',
      from: 'shipit://person/default/bob',
      to: 'shipit://team/default/api-team',
    },
    {
      type: 'MEMBER_OF',
      from: 'shipit://person/default/charlie',
      to: 'shipit://team/default/platform-team',
    },
    {
      type: 'MEMBER_OF',
      from: 'shipit://person/default/diana',
      to: 'shipit://team/default/platform-team',
    },
    {
      type: 'MEMBER_OF',
      from: 'shipit://person/default/eve',
      to: 'shipit://team/default/platform-team',
    },
    {
      type: 'MEMBER_OF',
      from: 'shipit://person/default/frank',
      to: 'shipit://team/default/ai-team',
    },
    {
      type: 'MEMBER_OF',
      from: 'shipit://person/default/grace',
      to: 'shipit://team/default/ai-team',
    },
    {
      type: 'MEMBER_OF',
      from: 'shipit://person/default/hank',
      to: 'shipit://team/default/api-team',
    },

    // BUILT_BY: Repository -> Pipeline
    {
      type: 'BUILT_BY',
      from: 'shipit://repository/default/graph-api',
      to: 'shipit://pipeline/default/graph-api-ci',
    },
    {
      type: 'BUILT_BY',
      from: 'shipit://repository/default/config-service',
      to: 'shipit://pipeline/default/config-service-ci',
    },
    {
      type: 'BUILT_BY',
      from: 'shipit://repository/default/connector-runtime',
      to: 'shipit://pipeline/default/connector-runtime-ci',
    },

    // MONITORS: Monitor -> LogicalService
    {
      type: 'MONITORS',
      from: 'shipit://monitor/default/graph-api-latency',
      to: 'shipit://logical-service/default/graph-api',
    },
    {
      type: 'MONITORS',
      from: 'shipit://monitor/default/graph-api-error-rate',
      to: 'shipit://logical-service/default/graph-api',
    },

    // CODEOWNER_OF: Person -> Repository
    {
      type: 'CODEOWNER_OF',
      from: 'shipit://person/default/alice',
      to: 'shipit://repository/default/graph-api',
    },
    {
      type: 'CODEOWNER_OF',
      from: 'shipit://person/default/charlie',
      to: 'shipit://repository/default/config-service',
    },

    // ON_CALL_FOR: Person -> LogicalService
    {
      type: 'ON_CALL_FOR',
      from: 'shipit://person/default/alice',
      to: 'shipit://logical-service/default/graph-api',
    },
    {
      type: 'ON_CALL_FOR',
      from: 'shipit://person/default/charlie',
      to: 'shipit://logical-service/default/config-service',
    },
  ],
};
