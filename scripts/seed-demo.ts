/**
 * Demo data seeder for ShipIt-AI Walking Skeleton.
 *
 * Seeds the Neo4j graph with a small-enterprise dataset ("Acme Pay") that
 * exercises every entity type the UI registers — LogicalService, Repository,
 * Deployment, RuntimeService, Pipeline, Monitor, Team, Person — and the
 * canonical relationships between them (IMPLEMENTED_BY, DEPLOYED_AS,
 * EMITS_TELEMETRY_AS, DEPENDS_ON, CALLS, MONITORS, OWNS, MEMBER_OF,
 * CODEOWNER_OF, BUILT_BY, ON_CALL_FOR).
 *
 * Usage: npx tsx scripts/seed-demo.ts
 */
import neo4j from 'neo4j-driver';

const NEO4J_URI = process.env['NEO4J_URI'] ?? 'bolt://localhost:7687';
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? 'shipit-dev';

interface SeedClaim {
  property_key: string;
  value: unknown;
  source: string;
  source_id: string;
  confidence: number;
}

interface SeedNode {
  label: string;
  id: string;
  properties: Record<string, unknown>;
  claims: SeedClaim[];
}

interface SeedEdge {
  type: string;
  fromId: string;
  toId: string;
  source: string;
  confidence: number;
}

const now = new Date().toISOString();
const NS = 'default';
const ORG = 'acme-pay';

// ─────────────────────────────────────────────────────────────────────────────
// ID helpers
// ─────────────────────────────────────────────────────────────────────────────

const id = {
  team: (slug: string) => `shipit://team/${NS}/${slug}`,
  person: (login: string) => `shipit://person/${NS}/${login}`,
  service: (name: string) => `shipit://logical-service/${NS}/${name}`,
  repo: (name: string) => `shipit://repository/${NS}/${name}`,
  deployment: (name: string) => `shipit://deployment/${NS}/${name}`,
  runtime: (name: string) => `shipit://runtime-service/${NS}/${name}`,
  pipeline: (name: string) => `shipit://pipeline/${NS}/${name}`,
  monitor: (name: string) => `shipit://monitor/${NS}/${name}`,
};

const claim = (key: string, value: unknown, source: string, sourceId: string): SeedClaim => ({
  property_key: key,
  value,
  source,
  source_id: sourceId,
  confidence: 0.9,
});

// ─────────────────────────────────────────────────────────────────────────────
// Teams
// ─────────────────────────────────────────────────────────────────────────────

interface TeamSpec {
  slug: string;
  name: string;
  email: string;
  description: string;
}

const teamSpecs: TeamSpec[] = [
  { slug: 'payments-team', name: 'Payments', email: 'payments@acmepay.com', description: 'Core money movement: charges, refunds, ledger.' },
  { slug: 'identity-team', name: 'Identity', email: 'identity@acmepay.com', description: 'Authentication, user accounts, permissions.' },
  { slug: 'storefront-team', name: 'Storefront', email: 'storefront@acmepay.com', description: 'Web checkout and merchant-facing UI.' },
  { slug: 'mobile-team', name: 'Mobile', email: 'mobile@acmepay.com', description: 'iOS and Android consumer apps and BFFs.' },
  { slug: 'data-team', name: 'Data Platform', email: 'data@acmepay.com', description: 'Warehousing, analytics, ML features.' },
  { slug: 'platform-team', name: 'Platform', email: 'platform@acmepay.com', description: 'Internal platform: config, notifications, dev tooling.' },
  { slug: 'sre-team', name: 'SRE', email: 'sre@acmepay.com', description: 'Reliability, on-call, observability.' },
  { slug: 'security-team', name: 'Security', email: 'security@acmepay.com', description: 'AppSec, audit, threat detection.' },
];

const teamNodes: SeedNode[] = teamSpecs.map((t) => ({
  label: 'Team',
  id: id.team(t.slug),
  properties: { name: t.name, slug: t.slug, email: t.email, description: t.description },
  claims: [
    claim('name', t.name, 'github', `github://${ORG}/team/${t.slug}`),
    claim('email', t.email, 'github', `github://${ORG}/team/${t.slug}`),
  ],
}));

// ─────────────────────────────────────────────────────────────────────────────
// People
// ─────────────────────────────────────────────────────────────────────────────

interface PersonSpec {
  login: string;
  name: string;
  email: string;
  role: string;
}

const personSpecs: PersonSpec[] = [
  // Payments
  { login: 'alice', name: 'Alice Chen', email: 'alice@acmepay.com', role: 'Staff Engineer' },
  { login: 'bob', name: 'Bob Okafor', email: 'bob@acmepay.com', role: 'Senior Engineer' },
  { login: 'hank', name: 'Hank Larsson', email: 'hank@acmepay.com', role: 'Senior Engineer' },
  { login: 'priya', name: 'Priya Iyer', email: 'priya@acmepay.com', role: 'Engineer' },
  // Identity
  { login: 'charlie', name: 'Charlie Park', email: 'charlie@acmepay.com', role: 'Staff Engineer' },
  { login: 'eve', name: 'Eve Martinez', email: 'eve@acmepay.com', role: 'Senior Engineer' },
  { login: 'noah', name: 'Noah Adler', email: 'noah@acmepay.com', role: 'Engineer' },
  // Storefront
  { login: 'diana', name: 'Diana Petrov', email: 'diana@acmepay.com', role: 'Senior Engineer' },
  { login: 'sam', name: 'Sam Rivera', email: 'sam@acmepay.com', role: 'Engineer' },
  // Mobile
  { login: 'kira', name: 'Kira Tanaka', email: 'kira@acmepay.com', role: 'Senior Engineer' },
  { login: 'leo', name: 'Leo Schmidt', email: 'leo@acmepay.com', role: 'Engineer' },
  // Data
  { login: 'frank', name: 'Frank Brown', email: 'frank@acmepay.com', role: 'Staff Engineer' },
  { login: 'rita', name: 'Rita Cohen', email: 'rita@acmepay.com', role: 'Data Engineer' },
  { login: 'maya', name: 'Maya Singh', email: 'maya@acmepay.com', role: 'ML Engineer' },
  // Platform
  { login: 'grace', name: 'Grace Holloway', email: 'grace@acmepay.com', role: 'Staff Engineer' },
  { login: 'omar', name: 'Omar Haddad', email: 'omar@acmepay.com', role: 'Senior Engineer' },
  { login: 'tina', name: 'Tina Wu', email: 'tina@acmepay.com', role: 'Engineer' },
  // SRE
  { login: 'jules', name: 'Jules Romano', email: 'jules@acmepay.com', role: 'SRE' },
  { login: 'mira', name: 'Mira Olsen', email: 'mira@acmepay.com', role: 'SRE' },
  // Security
  { login: 'devi', name: 'Devi Krishnan', email: 'devi@acmepay.com', role: 'Security Engineer' },
  { login: 'ian', name: 'Ian Whitlock', email: 'ian@acmepay.com', role: 'Security Engineer' },
];

const personNodes: SeedNode[] = personSpecs.map((p) => ({
  label: 'Person',
  id: id.person(p.login),
  properties: {
    login: p.login,
    name: p.name,
    email: p.email,
    role: p.role,
    url: `https://github.com/${p.login}`,
  },
  claims: [
    claim('login', p.login, 'github', `github://${ORG}/user/${p.login}`),
    claim('email', p.email, 'github', `github://${ORG}/user/${p.login}`),
    claim('name', p.name, 'github', `github://${ORG}/user/${p.login}`),
  ],
}));

// ─────────────────────────────────────────────────────────────────────────────
// Logical services
// ─────────────────────────────────────────────────────────────────────────────

type Lifecycle = 'production' | 'beta' | 'deprecated';

interface ServiceSpec {
  name: string;
  tier: 1 | 2 | 3;
  ownerTeam: string; // team slug
  lifecycle: Lifecycle;
  language: string;
  description: string;
}

const serviceSpecs: ServiceSpec[] = [
  // Payments domain
  { name: 'payments-api', tier: 1, ownerTeam: 'payments-team', lifecycle: 'production', language: 'Go', description: 'Charges, refunds, payment intent orchestration.' },
  { name: 'ledger-service', tier: 1, ownerTeam: 'payments-team', lifecycle: 'production', language: 'Go', description: 'Double-entry ledger of record.' },
  { name: 'fraud-detection', tier: 1, ownerTeam: 'payments-team', lifecycle: 'production', language: 'Python', description: 'Real-time fraud scoring on incoming charges.' },
  { name: 'card-issuance', tier: 2, ownerTeam: 'payments-team', lifecycle: 'production', language: 'Go', description: 'Virtual and physical card issuance.' },
  { name: 'billing-service', tier: 2, ownerTeam: 'payments-team', lifecycle: 'production', language: 'TypeScript', description: 'Recurring billing and invoicing.' },

  // Identity domain
  { name: 'auth-service', tier: 1, ownerTeam: 'identity-team', lifecycle: 'production', language: 'Go', description: 'OAuth2, sessions, MFA.' },
  { name: 'user-service', tier: 1, ownerTeam: 'identity-team', lifecycle: 'production', language: 'Go', description: 'User profile and account state.' },
  { name: 'permissions-service', tier: 2, ownerTeam: 'identity-team', lifecycle: 'production', language: 'Go', description: 'Role-based access control.' },

  // Storefront / mobile
  { name: 'web-storefront', tier: 1, ownerTeam: 'storefront-team', lifecycle: 'production', language: 'TypeScript', description: 'Public-facing merchant checkout.' },
  { name: 'mobile-bff', tier: 1, ownerTeam: 'mobile-team', lifecycle: 'production', language: 'TypeScript', description: 'Backend-for-frontend for iOS / Android.' },
  { name: 'search-service', tier: 2, ownerTeam: 'storefront-team', lifecycle: 'production', language: 'Go', description: 'Merchant + transaction search.' },
  { name: 'catalog-service', tier: 2, ownerTeam: 'storefront-team', lifecycle: 'production', language: 'Go', description: 'Product catalog metadata.' },

  // Data / ML
  { name: 'analytics-pipeline', tier: 3, ownerTeam: 'data-team', lifecycle: 'production', language: 'Python', description: 'Batch ETL feeding the warehouse.' },
  { name: 'ml-feature-store', tier: 2, ownerTeam: 'data-team', lifecycle: 'production', language: 'Python', description: 'Online feature serving for ML models.' },
  { name: 'recommendation-service', tier: 2, ownerTeam: 'data-team', lifecycle: 'beta', language: 'Python', description: 'Merchant recommendations (beta rollout).' },

  // Platform
  { name: 'config-service', tier: 1, ownerTeam: 'platform-team', lifecycle: 'production', language: 'Go', description: 'Centralized dynamic config + feature flags.' },
  { name: 'notification-service', tier: 2, ownerTeam: 'platform-team', lifecycle: 'production', language: 'Go', description: 'Email, SMS, push fan-out.' },
  { name: 'experimentation-service', tier: 3, ownerTeam: 'platform-team', lifecycle: 'beta', language: 'TypeScript', description: 'A/B test assignment + analysis (beta).' },
  { name: 'legacy-checkout', tier: 2, ownerTeam: 'storefront-team', lifecycle: 'deprecated', language: 'Ruby', description: 'Pre-rewrite checkout. Sunset target Q3.' },

  // Security
  { name: 'audit-log-service', tier: 2, ownerTeam: 'security-team', lifecycle: 'production', language: 'Go', description: 'Append-only audit trail for compliance.' },
];

const logicalServiceNodes: SeedNode[] = serviceSpecs.map((s) => ({
  label: 'LogicalService',
  id: id.service(s.name),
  properties: {
    name: s.name,
    tier: s.tier,
    owner: s.ownerTeam,
    lifecycle: s.lifecycle,
    language: s.language,
    description: s.description,
  },
  claims: [
    claim('name', s.name, 'backstage', `backstage://component/${s.name}`),
    claim('tier', s.tier, 'backstage', `backstage://component/${s.name}`),
    claim('owner', s.ownerTeam, 'backstage', `backstage://component/${s.name}`),
    claim('lifecycle', s.lifecycle, 'backstage', `backstage://component/${s.name}`),
  ],
}));

// ─────────────────────────────────────────────────────────────────────────────
// Repositories — one per service plus a few shared libs.
// ─────────────────────────────────────────────────────────────────────────────

interface RepoSpec {
  name: string;
  language: string;
  visibility: 'public' | 'private';
  owner: string; // team slug — mirrors CODEOWNERS
  /** Inherited from the implementing service. Shared libs have no tier. */
  tier?: 1 | 2 | 3;
}

const repoSpecs: RepoSpec[] = [
  ...serviceSpecs.map<RepoSpec>((s) => ({
    name: s.name,
    language: s.language,
    visibility: 'private',
    owner: s.ownerTeam,
    tier: s.tier,
  })),
  { name: 'shared-go-lib', language: 'Go', visibility: 'private', owner: 'platform-team' },
  { name: 'shared-ts-lib', language: 'TypeScript', visibility: 'private', owner: 'platform-team' },
  { name: 'proto-schemas', language: 'Protobuf', visibility: 'private', owner: 'platform-team' },
  { name: 'terraform-modules', language: 'HCL', visibility: 'private', owner: 'sre-team' },
  { name: 'open-sdk', language: 'TypeScript', visibility: 'public', owner: 'platform-team' },
];

const repoOwnerByName = new Map(repoSpecs.map((r) => [r.name, r.owner]));

const repoNodes: SeedNode[] = repoSpecs.map((r) => ({
  label: 'Repository',
  id: id.repo(r.name),
  properties: {
    name: r.name,
    url: `https://github.com/${ORG}/${r.name}`,
    default_branch: 'main',
    visibility: r.visibility,
    language: r.language,
    owner: r.owner,
    ...(r.tier !== undefined ? { tier: r.tier } : {}),
  },
  claims: [
    claim('name', r.name, 'github', `github://${ORG}/${r.name}`),
    claim('language', r.language, 'github', `github://${ORG}/${r.name}`),
    claim('visibility', r.visibility, 'github', `github://${ORG}/${r.name}`),
    claim('owner', r.owner, 'github', `github://${ORG}/${r.name}/CODEOWNERS`),
  ],
}));

// ─────────────────────────────────────────────────────────────────────────────
// Deployments — multi-region for tier-1 services, single-region for the rest.
// ─────────────────────────────────────────────────────────────────────────────

interface DeploymentSpec {
  service: string;
  env: 'production' | 'staging' | 'dev';
  region: 'us-east' | 'us-west' | 'eu-west' | 'global';
  replicas: number;
}

function deploymentsFor(service: ServiceSpec): DeploymentSpec[] {
  if (service.lifecycle === 'deprecated') {
    return [{ service: service.name, env: 'production', region: 'us-east', replicas: 1 }];
  }
  if (service.tier === 1) {
    return [
      { service: service.name, env: 'production', region: 'us-east', replicas: 4 },
      { service: service.name, env: 'production', region: 'eu-west', replicas: 3 },
      { service: service.name, env: 'staging', region: 'us-east', replicas: 1 },
    ];
  }
  if (service.tier === 2) {
    return [
      { service: service.name, env: 'production', region: 'us-east', replicas: 2 },
      { service: service.name, env: 'staging', region: 'us-east', replicas: 1 },
    ];
  }
  return [{ service: service.name, env: 'production', region: 'us-east', replicas: 1 }];
}

const deploymentSpecs: DeploymentSpec[] = serviceSpecs.flatMap(deploymentsFor);

const serviceByName = new Map(serviceSpecs.map((s) => [s.name, s]));

const deploymentNodes: SeedNode[] = deploymentSpecs.map((d) => {
  const svc = serviceByName.get(d.service)!;
  const dName = `${d.service}-${d.env}-${d.region}`;
  return {
    label: 'Deployment',
    id: id.deployment(dName),
    properties: {
      name: dName,
      service: d.service,
      environment: d.env,
      region: d.region,
      replicas: d.replicas,
      cluster: `${d.region}-${d.env === 'production' ? 'prod' : 'np'}`,
      tier: svc.tier,
      owner: svc.ownerTeam,
    },
    claims: [
      claim('name', dName, 'kubernetes', `k8s://${d.region}/${d.env}/${d.service}`),
      claim('environment', d.env, 'kubernetes', `k8s://${d.region}/${d.env}/${d.service}`),
      claim('replicas', d.replicas, 'kubernetes', `k8s://${d.region}/${d.env}/${d.service}`),
    ],
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// Runtime services — one telemetry signal per logical service.
// ─────────────────────────────────────────────────────────────────────────────

const runtimeNodes: SeedNode[] = serviceSpecs
  .filter((s) => s.lifecycle !== 'deprecated')
  .map((s) => ({
    label: 'RuntimeService',
    id: id.runtime(`${s.name}-runtime`),
    properties: {
      name: `${s.name}-runtime`,
      service: s.name,
      protocol: s.language === 'TypeScript' || s.language === 'Python' ? 'http' : 'grpc',
      tier: s.tier,
      owner: s.ownerTeam,
    },
    claims: [
      claim('name', `${s.name}-runtime`, 'datadog', `datadog://apm/${s.name}`),
      claim('service', s.name, 'datadog', `datadog://apm/${s.name}`),
    ],
  }));

// ─────────────────────────────────────────────────────────────────────────────
// Pipelines — CI/CD for prod services plus a couple of infra pipelines.
// ─────────────────────────────────────────────────────────────────────────────

interface PipelineSpec {
  name: string;
  type: 'ci' | 'cd' | 'etl' | 'infra';
  repo?: string;
}

const pipelineSpecs: PipelineSpec[] = [
  ...serviceSpecs
    .filter((s) => s.lifecycle === 'production' && s.tier !== 3)
    .map<PipelineSpec>((s) => ({ name: `${s.name}-ci`, type: 'ci', repo: s.name })),
  { name: 'analytics-etl', type: 'etl', repo: 'analytics-pipeline' },
  { name: 'ml-training', type: 'etl', repo: 'ml-feature-store' },
  { name: 'terraform-apply', type: 'infra', repo: 'terraform-modules' },
  { name: 'release-train', type: 'cd' },
];

const pipelineNodes: SeedNode[] = pipelineSpecs.map((p) => {
  const owner =
    (p.repo && repoOwnerByName.get(p.repo)) ?? 'platform-team';
  return {
    label: 'Pipeline',
    id: id.pipeline(p.name),
    properties: { name: p.name, type: p.type, state: 'active', owner },
    claims: [claim('name', p.name, 'github', `github://${ORG}/actions/${p.name}`)],
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// Monitors — Datadog-style monitors mostly on tier-1 / tier-2 services.
// ─────────────────────────────────────────────────────────────────────────────

interface MonitorSpec {
  name: string;
  service: string;
  status: 'OK' | 'WARN' | 'ALERT';
  metric: string;
}

const monitorSpecs: MonitorSpec[] = [
  { name: 'payments-latency-p99', service: 'payments-api', status: 'OK', metric: 'http.latency.p99' },
  { name: 'payments-error-rate', service: 'payments-api', status: 'WARN', metric: 'http.errors.5xx' },
  { name: 'payments-saturation', service: 'payments-api', status: 'OK', metric: 'cpu.utilization' },
  { name: 'ledger-double-spend', service: 'ledger-service', status: 'OK', metric: 'ledger.double_spend.detected' },
  { name: 'ledger-replication-lag', service: 'ledger-service', status: 'OK', metric: 'db.replication.lag' },
  { name: 'fraud-fp-rate', service: 'fraud-detection', status: 'WARN', metric: 'fraud.false_positive.rate' },
  { name: 'auth-login-latency', service: 'auth-service', status: 'OK', metric: 'auth.login.latency' },
  { name: 'auth-failure-rate', service: 'auth-service', status: 'OK', metric: 'auth.failures' },
  { name: 'user-service-availability', service: 'user-service', status: 'OK', metric: 'http.availability' },
  { name: 'storefront-page-load', service: 'web-storefront', status: 'OK', metric: 'rum.page_load' },
  { name: 'storefront-checkout-funnel', service: 'web-storefront', status: 'ALERT', metric: 'rum.funnel.dropoff' },
  { name: 'search-latency', service: 'search-service', status: 'OK', metric: 'search.latency.p95' },
  { name: 'config-availability', service: 'config-service', status: 'OK', metric: 'http.availability' },
  { name: 'notification-delivery', service: 'notification-service', status: 'WARN', metric: 'notif.delivery.rate' },
  { name: 'analytics-pipeline-lag', service: 'analytics-pipeline', status: 'OK', metric: 'pipeline.lag.minutes' },
  { name: 'billing-invoice-failure', service: 'billing-service', status: 'OK', metric: 'billing.invoice.failed' },
];

const monitorNodes: SeedNode[] = monitorSpecs.map((m) => {
  const svc = serviceByName.get(m.service)!;
  return {
    label: 'Monitor',
    id: id.monitor(m.name),
    properties: {
      name: m.name,
      service: m.service,
      status: m.status,
      metric: m.metric,
      tier: svc.tier,
      owner: svc.ownerTeam,
    },
    claims: [
      claim('name', m.name, 'datadog', `datadog://monitor/${m.name}`),
      claim('status', m.status, 'datadog', `datadog://monitor/${m.name}`),
    ],
  };
});

// ─────────────────────────────────────────────────────────────────────────────
// All nodes
// ─────────────────────────────────────────────────────────────────────────────

const nodes: SeedNode[] = [
  ...teamNodes,
  ...personNodes,
  ...logicalServiceNodes,
  ...repoNodes,
  ...deploymentNodes,
  ...runtimeNodes,
  ...pipelineNodes,
  ...monitorNodes,
];

// ─────────────────────────────────────────────────────────────────────────────
// Edges
// ─────────────────────────────────────────────────────────────────────────────

const edges: SeedEdge[] = [];

function edge(
  type: string,
  fromId: string,
  toId: string,
  source: string = 'github',
  confidence: number = 0.9,
) {
  edges.push({ type, fromId, toId, source, confidence });
}

// IMPLEMENTED_BY: LogicalService -> Repository (1:1 by service name)
for (const s of serviceSpecs) {
  edge('IMPLEMENTED_BY', id.service(s.name), id.repo(s.name), 'backstage', 0.95);
}

// DEPLOYED_AS: LogicalService -> Deployment
for (const d of deploymentSpecs) {
  const dName = `${d.service}-${d.env}-${d.region}`;
  edge('DEPLOYED_AS', id.service(d.service), id.deployment(dName), 'kubernetes', 0.95);
}

// EMITS_TELEMETRY_AS: LogicalService -> RuntimeService
for (const r of runtimeNodes) {
  const svcName = (r.properties['service'] as string) ?? '';
  edge('EMITS_TELEMETRY_AS', id.service(svcName), r.id, 'datadog', 0.9);
}

// OWNS: Team -> LogicalService
for (const s of serviceSpecs) {
  edge('OWNS', id.team(s.ownerTeam), id.service(s.name), 'backstage', 0.95);
}

// BUILT_BY: Repository -> Pipeline (by repo property)
for (const p of pipelineSpecs) {
  if (p.repo) edge('BUILT_BY', id.repo(p.repo), id.pipeline(p.name));
}

// MONITORS: Monitor -> LogicalService
for (const m of monitorSpecs) {
  edge('MONITORS', id.monitor(m.name), id.service(m.service), 'datadog', 0.95);
}

// DEPENDS_ON: LogicalService -> LogicalService (business-level dependencies)
const serviceDeps: Array<[string, string]> = [
  ['payments-api', 'auth-service'],
  ['payments-api', 'user-service'],
  ['payments-api', 'fraud-detection'],
  ['payments-api', 'ledger-service'],
  ['payments-api', 'config-service'],
  ['payments-api', 'notification-service'],
  ['ledger-service', 'config-service'],
  ['ledger-service', 'audit-log-service'],
  ['fraud-detection', 'ml-feature-store'],
  ['fraud-detection', 'config-service'],
  ['card-issuance', 'payments-api'],
  ['card-issuance', 'auth-service'],
  ['card-issuance', 'notification-service'],
  ['billing-service', 'payments-api'],
  ['billing-service', 'notification-service'],
  ['billing-service', 'ledger-service'],
  ['auth-service', 'user-service'],
  ['auth-service', 'permissions-service'],
  ['auth-service', 'audit-log-service'],
  ['user-service', 'config-service'],
  ['permissions-service', 'config-service'],
  ['web-storefront', 'auth-service'],
  ['web-storefront', 'payments-api'],
  ['web-storefront', 'search-service'],
  ['web-storefront', 'catalog-service'],
  ['web-storefront', 'recommendation-service'],
  ['mobile-bff', 'auth-service'],
  ['mobile-bff', 'payments-api'],
  ['mobile-bff', 'user-service'],
  ['mobile-bff', 'catalog-service'],
  ['search-service', 'catalog-service'],
  ['catalog-service', 'config-service'],
  ['recommendation-service', 'ml-feature-store'],
  ['recommendation-service', 'catalog-service'],
  ['analytics-pipeline', 'ledger-service'],
  ['analytics-pipeline', 'user-service'],
  ['analytics-pipeline', 'audit-log-service'],
  ['ml-feature-store', 'analytics-pipeline'],
  ['notification-service', 'user-service'],
  ['notification-service', 'config-service'],
  ['experimentation-service', 'config-service'],
  ['experimentation-service', 'analytics-pipeline'],
  ['legacy-checkout', 'payments-api'],
];
for (const [from, to] of serviceDeps) {
  edge('DEPENDS_ON', id.service(from), id.service(to), 'backstage', 0.85);
}

// DEPENDS_ON: Repository -> Repository (shared library usage)
const sharedGoUsers = ['payments-api', 'ledger-service', 'card-issuance', 'auth-service', 'user-service', 'permissions-service', 'search-service', 'catalog-service', 'config-service', 'notification-service', 'audit-log-service'];
const sharedTsUsers = ['web-storefront', 'mobile-bff', 'billing-service', 'experimentation-service'];
const protoUsers = ['payments-api', 'ledger-service', 'fraud-detection', 'auth-service', 'user-service', 'mobile-bff', 'web-storefront'];
for (const r of sharedGoUsers) edge('DEPENDS_ON', id.repo(r), id.repo('shared-go-lib'), 'github', 0.85);
for (const r of sharedTsUsers) edge('DEPENDS_ON', id.repo(r), id.repo('shared-ts-lib'), 'github', 0.85);
for (const r of protoUsers) edge('DEPENDS_ON', id.repo(r), id.repo('proto-schemas'), 'github', 0.85);

// CALLS: RuntimeService -> RuntimeService (mirrors a subset of service deps so
// the runtime call graph reads as the "hot path" rather than every logical
// dependency)
const runtimeCalls: Array<[string, string]> = [
  ['web-storefront', 'mobile-bff'], // shared API surface
  ['web-storefront', 'auth-service'],
  ['web-storefront', 'payments-api'],
  ['web-storefront', 'search-service'],
  ['mobile-bff', 'auth-service'],
  ['mobile-bff', 'payments-api'],
  ['mobile-bff', 'catalog-service'],
  ['payments-api', 'auth-service'],
  ['payments-api', 'fraud-detection'],
  ['payments-api', 'ledger-service'],
  ['payments-api', 'notification-service'],
  ['card-issuance', 'payments-api'],
  ['billing-service', 'payments-api'],
  ['billing-service', 'notification-service'],
  ['fraud-detection', 'ml-feature-store'],
  ['recommendation-service', 'ml-feature-store'],
  ['auth-service', 'user-service'],
  ['auth-service', 'permissions-service'],
  ['search-service', 'catalog-service'],
];
for (const [from, to] of runtimeCalls) {
  edge('CALLS', id.runtime(`${from}-runtime`), id.runtime(`${to}-runtime`), 'datadog', 0.9);
}

// MEMBER_OF: Person -> Team
const memberships: Array<[string, string]> = [
  ['alice', 'payments-team'],
  ['bob', 'payments-team'],
  ['hank', 'payments-team'],
  ['priya', 'payments-team'],
  ['charlie', 'identity-team'],
  ['eve', 'identity-team'],
  ['noah', 'identity-team'],
  ['diana', 'storefront-team'],
  ['sam', 'storefront-team'],
  ['kira', 'mobile-team'],
  ['leo', 'mobile-team'],
  ['frank', 'data-team'],
  ['rita', 'data-team'],
  ['maya', 'data-team'],
  ['grace', 'platform-team'],
  ['omar', 'platform-team'],
  ['tina', 'platform-team'],
  ['jules', 'sre-team'],
  ['mira', 'sre-team'],
  ['devi', 'security-team'],
  ['ian', 'security-team'],
];
for (const [login, team] of memberships) {
  edge('MEMBER_OF', id.person(login), id.team(team));
}

// CODEOWNER_OF: Team -> Repository (the owning team owns its service's repo)
for (const s of serviceSpecs) {
  edge('CODEOWNER_OF', id.team(s.ownerTeam), id.repo(s.name), 'github', 0.95);
}
// Shared libs: platform / SRE own infra-ish ones, data team owns the analytics shared bits
edge('CODEOWNER_OF', id.team('platform-team'), id.repo('shared-go-lib'), 'github', 0.95);
edge('CODEOWNER_OF', id.team('platform-team'), id.repo('shared-ts-lib'), 'github', 0.95);
edge('CODEOWNER_OF', id.team('platform-team'), id.repo('proto-schemas'), 'github', 0.95);
edge('CODEOWNER_OF', id.team('sre-team'), id.repo('terraform-modules'), 'github', 0.95);
edge('CODEOWNER_OF', id.team('platform-team'), id.repo('open-sdk'), 'github', 0.95);

// CODEOWNER_OF: Person -> Repository (individual codeowner overrides for the
// services where someone is the de-facto owner)
const individualCodeowners: Array<[string, string]> = [
  ['alice', 'payments-api'],
  ['alice', 'ledger-service'],
  ['bob', 'fraud-detection'],
  ['hank', 'card-issuance'],
  ['priya', 'billing-service'],
  ['charlie', 'auth-service'],
  ['eve', 'user-service'],
  ['noah', 'permissions-service'],
  ['diana', 'web-storefront'],
  ['sam', 'search-service'],
  ['kira', 'mobile-bff'],
  ['frank', 'analytics-pipeline'],
  ['maya', 'ml-feature-store'],
  ['rita', 'recommendation-service'],
  ['grace', 'config-service'],
  ['omar', 'notification-service'],
  ['tina', 'experimentation-service'],
  ['devi', 'audit-log-service'],
];
for (const [login, repo] of individualCodeowners) {
  edge('CODEOWNER_OF', id.person(login), id.repo(repo), 'github', 0.9);
}

// ON_CALL_FOR: Person -> LogicalService (one or two on-calls per critical svc)
const onCall: Array<[string, string]> = [
  ['alice', 'payments-api'],
  ['hank', 'payments-api'],
  ['alice', 'ledger-service'],
  ['bob', 'fraud-detection'],
  ['charlie', 'auth-service'],
  ['eve', 'user-service'],
  ['diana', 'web-storefront'],
  ['kira', 'mobile-bff'],
  ['grace', 'config-service'],
  ['jules', 'payments-api'],
  ['mira', 'auth-service'],
  ['mira', 'web-storefront'],
];
for (const [login, svc] of onCall) {
  edge('ON_CALL_FOR', id.person(login), id.service(svc), 'pagerduty', 0.95);
}

// ─────────────────────────────────────────────────────────────────────────────
// Writer
// ─────────────────────────────────────────────────────────────────────────────

async function seed() {
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));

  try {
    await driver.verifyConnectivity();
    console.log('Connected to Neo4j');

    const session = driver.session();

    try {
      console.log(`\nSeeding ${nodes.length} nodes...`);
      for (const node of nodes) {
        const claimsWithTimestamp = node.claims.map((c) => ({
          ...c,
          ingested_at: now,
          evidence: null,
        }));

        await session.run(
          `MERGE (n:${node.label} {id: $id})
           SET n += $properties,
               n._claims = $claims,
               n._source_system = $sourceSystem,
               n._source_org = $sourceOrg,
               n._last_synced = $now,
               n._event_version = 1`,
          {
            id: node.id,
            properties: node.properties,
            claims: JSON.stringify(claimsWithTimestamp),
            now,
            sourceSystem: claimsWithTimestamp[0]?.source ?? 'github',
            sourceOrg: `github/${ORG}`,
          },
        );
      }
      console.log(`  Done (${nodes.length} nodes).`);

      console.log(`\nSeeding ${edges.length} edges...`);
      for (const e of edges) {
        await session.run(
          `MATCH (a {id: $fromId})
           MATCH (b {id: $toId})
           MERGE (a)-[r:${e.type}]->(b)
           SET r._source = $source,
               r._confidence = $confidence,
               r._ingested_at = $now`,
          {
            fromId: e.fromId,
            toId: e.toId,
            source: e.source,
            confidence: e.confidence,
            now,
          },
        );
      }
      console.log(`  Done (${edges.length} edges).`);

      const nodeResult = await session.run(
        `MATCH (n) WHERE NOT n:LinkingKey AND NOT n:_LinkingKey
           AND NOT n:IdempotencyLog AND NOT n:_IdempotencyLog
           AND NOT n:SchemaNodeType AND NOT n:SchemaRelType
         RETURN labels(n)[0] AS label, count(n) AS count
         ORDER BY label`,
      );
      console.log('\nGraph summary:');
      for (const record of nodeResult.records) {
        console.log(`  ${record.get('label')}: ${record.get('count').toString()}`);
      }

      const edgeResult = await session.run(
        `MATCH ()-[r]->() RETURN type(r) AS type, count(r) AS count
         ORDER BY type`,
      );
      console.log('');
      for (const record of edgeResult.records) {
        console.log(`  ${record.get('type')}: ${record.get('count').toString()} edges`);
      }

      console.log('\nDemo data seeded successfully.');
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
