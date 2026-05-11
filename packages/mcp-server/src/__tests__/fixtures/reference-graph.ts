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
      id: 'shipit://logical-service/default/payments-api',
      label: 'LogicalService',
      properties: {
        name: 'payments-api',
        tier_effective: 1,
        owner_effective: 'payments-team',
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
      id: 'shipit://logical-service/default/ledger-service',
      label: 'LogicalService',
      properties: {
        name: 'ledger-service',
        tier_effective: 1,
        owner_effective: 'payments-team',
        lifecycle_effective: 'production',
      },
    },
    {
      id: 'shipit://logical-service/default/card-issuance',
      label: 'LogicalService',
      properties: {
        name: 'card-issuance',
        tier_effective: 2,
        owner_effective: 'cards-team',
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
      id: 'shipit://repository/default/payments-api',
      label: 'Repository',
      properties: { name: 'payments-api', url: 'https://github.com/acme/payments-api' },
    },
    {
      id: 'shipit://repository/default/config-service',
      label: 'Repository',
      properties: { name: 'config-service', url: 'https://github.com/acme/config-service' },
    },
    {
      id: 'shipit://repository/default/ledger-service',
      label: 'Repository',
      properties: { name: 'ledger-service', url: 'https://github.com/acme/ledger-service' },
    },
    {
      id: 'shipit://repository/default/card-issuance',
      label: 'Repository',
      properties: { name: 'card-issuance', url: 'https://github.com/acme/card-issuance' },
    },
    {
      id: 'shipit://repository/default/auth-service',
      label: 'Repository',
      properties: { name: 'auth-service', url: 'https://github.com/acme/auth-service' },
    },

    // Deployments (10: 2 per service: staging + prod)
    {
      id: 'shipit://deployment/default/payments-api-prod',
      label: 'Deployment',
      properties: { name: 'payments-api-prod', environment: 'production', replicas: 3 },
    },
    {
      id: 'shipit://deployment/default/payments-api-staging',
      label: 'Deployment',
      properties: { name: 'payments-api-staging', environment: 'staging', replicas: 1 },
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
      id: 'shipit://deployment/default/ledger-service-prod',
      label: 'Deployment',
      properties: { name: 'ledger-service-prod', environment: 'production', replicas: 3 },
    },
    {
      id: 'shipit://deployment/default/ledger-service-staging',
      label: 'Deployment',
      properties: { name: 'ledger-service-staging', environment: 'staging', replicas: 1 },
    },
    {
      id: 'shipit://deployment/default/card-issuance-prod',
      label: 'Deployment',
      properties: { name: 'card-issuance-prod', environment: 'production', replicas: 2 },
    },
    {
      id: 'shipit://deployment/default/card-issuance-staging',
      label: 'Deployment',
      properties: { name: 'card-issuance-staging', environment: 'staging', replicas: 1 },
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
      id: 'shipit://runtime-service/default/payments-api-runtime',
      label: 'RuntimeService',
      properties: { name: 'payments-api-runtime' },
    },
    {
      id: 'shipit://runtime-service/default/config-service-runtime',
      label: 'RuntimeService',
      properties: { name: 'config-service-runtime' },
    },
    {
      id: 'shipit://runtime-service/default/ledger-service-runtime',
      label: 'RuntimeService',
      properties: { name: 'ledger-service-runtime' },
    },
    {
      id: 'shipit://runtime-service/default/card-issuance-runtime',
      label: 'RuntimeService',
      properties: { name: 'card-issuance-runtime' },
    },
    {
      id: 'shipit://runtime-service/default/auth-service-runtime',
      label: 'RuntimeService',
      properties: { name: 'auth-service-runtime' },
    },

    // Teams (3)
    {
      id: 'shipit://team/default/payments-team',
      label: 'Team',
      properties: { name: 'payments-team', email: 'payments@acme.com' },
    },
    {
      id: 'shipit://team/default/platform-team',
      label: 'Team',
      properties: { name: 'platform-team', email: 'platform@acme.com' },
    },
    {
      id: 'shipit://team/default/cards-team',
      label: 'Team',
      properties: { name: 'cards-team', email: 'cards@acme.com' },
    },

    // Persons (8)
    {
      id: 'shipit://person/default/alice',
      label: 'Person',
      properties: { name: 'Alice Smith', email: 'alice@acme.com' },
    },
    {
      id: 'shipit://person/default/bob',
      label: 'Person',
      properties: { name: 'Bob Jones', email: 'bob@acme.com' },
    },
    {
      id: 'shipit://person/default/charlie',
      label: 'Person',
      properties: { name: 'Charlie Brown', email: 'charlie@acme.com' },
    },
    {
      id: 'shipit://person/default/diana',
      label: 'Person',
      properties: { name: 'Diana Prince', email: 'diana@acme.com' },
    },
    {
      id: 'shipit://person/default/eve',
      label: 'Person',
      properties: { name: 'Eve Wilson', email: 'eve@acme.com' },
    },
    {
      id: 'shipit://person/default/frank',
      label: 'Person',
      properties: { name: 'Frank Castle', email: 'frank@acme.com' },
    },
    {
      id: 'shipit://person/default/grace',
      label: 'Person',
      properties: { name: 'Grace Hopper', email: 'grace@acme.com' },
    },
    {
      id: 'shipit://person/default/hank',
      label: 'Person',
      properties: { name: 'Hank Pym', email: 'hank@acme.com' },
    },

    // Pipelines (3)
    {
      id: 'shipit://pipeline/default/payments-ci',
      label: 'Pipeline',
      properties: { name: 'payments-ci', type: 'CI/CD' },
    },
    {
      id: 'shipit://pipeline/default/config-ci',
      label: 'Pipeline',
      properties: { name: 'config-ci', type: 'CI/CD' },
    },
    {
      id: 'shipit://pipeline/default/cards-ci',
      label: 'Pipeline',
      properties: { name: 'cards-ci', type: 'CI/CD' },
    },

    // Monitors (2)
    {
      id: 'shipit://monitor/default/payments-latency',
      label: 'Monitor',
      properties: { name: 'payments-latency', status: 'OK' },
    },
    {
      id: 'shipit://monitor/default/payments-error-rate',
      label: 'Monitor',
      properties: { name: 'payments-error-rate', status: 'OK' },
    },
  ],

  edges: [
    // IMPLEMENTED_BY: LogicalService -> Repository
    {
      type: 'IMPLEMENTED_BY',
      from: 'shipit://logical-service/default/payments-api',
      to: 'shipit://repository/default/payments-api',
    },
    {
      type: 'IMPLEMENTED_BY',
      from: 'shipit://logical-service/default/config-service',
      to: 'shipit://repository/default/config-service',
    },
    {
      type: 'IMPLEMENTED_BY',
      from: 'shipit://logical-service/default/ledger-service',
      to: 'shipit://repository/default/ledger-service',
    },
    {
      type: 'IMPLEMENTED_BY',
      from: 'shipit://logical-service/default/card-issuance',
      to: 'shipit://repository/default/card-issuance',
    },
    {
      type: 'IMPLEMENTED_BY',
      from: 'shipit://logical-service/default/auth-service',
      to: 'shipit://repository/default/auth-service',
    },

    // DEPLOYED_AS: LogicalService -> Deployment
    {
      type: 'DEPLOYED_AS',
      from: 'shipit://logical-service/default/payments-api',
      to: 'shipit://deployment/default/payments-api-prod',
    },
    {
      type: 'DEPLOYED_AS',
      from: 'shipit://logical-service/default/payments-api',
      to: 'shipit://deployment/default/payments-api-staging',
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
      from: 'shipit://logical-service/default/ledger-service',
      to: 'shipit://deployment/default/ledger-service-prod',
    },
    {
      type: 'DEPLOYED_AS',
      from: 'shipit://logical-service/default/ledger-service',
      to: 'shipit://deployment/default/ledger-service-staging',
    },
    {
      type: 'DEPLOYED_AS',
      from: 'shipit://logical-service/default/card-issuance',
      to: 'shipit://deployment/default/card-issuance-prod',
    },
    {
      type: 'DEPLOYED_AS',
      from: 'shipit://logical-service/default/card-issuance',
      to: 'shipit://deployment/default/card-issuance-staging',
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
      from: 'shipit://logical-service/default/payments-api',
      to: 'shipit://runtime-service/default/payments-api-runtime',
    },
    {
      type: 'EMITS_TELEMETRY_AS',
      from: 'shipit://logical-service/default/config-service',
      to: 'shipit://runtime-service/default/config-service-runtime',
    },
    {
      type: 'EMITS_TELEMETRY_AS',
      from: 'shipit://logical-service/default/ledger-service',
      to: 'shipit://runtime-service/default/ledger-service-runtime',
    },
    {
      type: 'EMITS_TELEMETRY_AS',
      from: 'shipit://logical-service/default/card-issuance',
      to: 'shipit://runtime-service/default/card-issuance-runtime',
    },
    {
      type: 'EMITS_TELEMETRY_AS',
      from: 'shipit://logical-service/default/auth-service',
      to: 'shipit://runtime-service/default/auth-service-runtime',
    },

    // DEPENDS_ON: LogicalService -> LogicalService
    {
      type: 'DEPENDS_ON',
      from: 'shipit://logical-service/default/payments-api',
      to: 'shipit://logical-service/default/config-service',
    },
    {
      type: 'DEPENDS_ON',
      from: 'shipit://logical-service/default/payments-api',
      to: 'shipit://logical-service/default/auth-service',
    },
    {
      type: 'DEPENDS_ON',
      from: 'shipit://logical-service/default/ledger-service',
      to: 'shipit://logical-service/default/config-service',
    },
    {
      type: 'DEPENDS_ON',
      from: 'shipit://logical-service/default/card-issuance',
      to: 'shipit://logical-service/default/payments-api',
    },
    {
      type: 'DEPENDS_ON',
      from: 'shipit://logical-service/default/card-issuance',
      to: 'shipit://logical-service/default/auth-service',
    },

    // CALLS: RuntimeService -> RuntimeService
    {
      type: 'CALLS',
      from: 'shipit://runtime-service/default/payments-api-runtime',
      to: 'shipit://runtime-service/default/config-service-runtime',
    },
    {
      type: 'CALLS',
      from: 'shipit://runtime-service/default/card-issuance-runtime',
      to: 'shipit://runtime-service/default/payments-api-runtime',
    },

    // OWNS: Team -> LogicalService
    {
      type: 'OWNS',
      from: 'shipit://team/default/payments-team',
      to: 'shipit://logical-service/default/payments-api',
    },
    {
      type: 'OWNS',
      from: 'shipit://team/default/payments-team',
      to: 'shipit://logical-service/default/ledger-service',
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
      from: 'shipit://team/default/cards-team',
      to: 'shipit://logical-service/default/card-issuance',
    },

    // MEMBER_OF: Person -> Team
    {
      type: 'MEMBER_OF',
      from: 'shipit://person/default/alice',
      to: 'shipit://team/default/payments-team',
    },
    {
      type: 'MEMBER_OF',
      from: 'shipit://person/default/bob',
      to: 'shipit://team/default/payments-team',
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
      to: 'shipit://team/default/cards-team',
    },
    {
      type: 'MEMBER_OF',
      from: 'shipit://person/default/grace',
      to: 'shipit://team/default/cards-team',
    },
    {
      type: 'MEMBER_OF',
      from: 'shipit://person/default/hank',
      to: 'shipit://team/default/payments-team',
    },

    // BUILT_BY: Repository -> Pipeline
    {
      type: 'BUILT_BY',
      from: 'shipit://repository/default/payments-api',
      to: 'shipit://pipeline/default/payments-ci',
    },
    {
      type: 'BUILT_BY',
      from: 'shipit://repository/default/config-service',
      to: 'shipit://pipeline/default/config-ci',
    },
    {
      type: 'BUILT_BY',
      from: 'shipit://repository/default/card-issuance',
      to: 'shipit://pipeline/default/cards-ci',
    },

    // MONITORS: Monitor -> LogicalService
    {
      type: 'MONITORS',
      from: 'shipit://monitor/default/payments-latency',
      to: 'shipit://logical-service/default/payments-api',
    },
    {
      type: 'MONITORS',
      from: 'shipit://monitor/default/payments-error-rate',
      to: 'shipit://logical-service/default/payments-api',
    },

    // CODEOWNER_OF: Person -> Repository
    {
      type: 'CODEOWNER_OF',
      from: 'shipit://person/default/alice',
      to: 'shipit://repository/default/payments-api',
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
      to: 'shipit://logical-service/default/payments-api',
    },
    {
      type: 'ON_CALL_FOR',
      from: 'shipit://person/default/charlie',
      to: 'shipit://logical-service/default/config-service',
    },
  ],
};
