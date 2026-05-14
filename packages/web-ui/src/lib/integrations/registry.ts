import { datadogAdapter } from './datadog';
import { gitHubAdapter } from './github';
import { kubernetesAdapter } from './kubernetes';
import { pagerDutyAdapter } from './pagerduty';
import { slackAdapter } from './slack';
import type {
  Deeplink,
  DeploymentContext,
  IncidentIntegration,
  MonitorContext,
  PersonContext,
  RepositoryContext,
  ServiceContext,
  TeamContext,
} from './types';

/**
 * Built-in adapter set. Order matters only for tie-breaking in UI lists —
 * adapters that are commonly wired first appear first. Customers extending
 * this can call `registerIntegration(...)` from app bootstrap.
 */
const BUILT_IN: IncidentIntegration[] = [
  pagerDutyAdapter,
  datadogAdapter,
  gitHubAdapter,
  kubernetesAdapter,
  slackAdapter,
];

const registry: IncidentIntegration[] = [...BUILT_IN];

export function registerIntegration(adapter: IncidentIntegration): void {
  // Replace if id already registered so overrides are predictable.
  const idx = registry.findIndex((a) => a.id === adapter.id);
  if (idx >= 0) registry[idx] = adapter;
  else registry.push(adapter);
}

export function listConfiguredIntegrations(): IncidentIntegration[] {
  return registry.filter((a) => a.isConfigured());
}

/**
 * Build a deeplink from each adapter that can resolve one for the given
 * capability. Adapters that don't implement the capability or return null
 * are filtered out — the UI never sees a half-baked link.
 */
function collect<T>(
  ctx: T,
  capability: (a: IncidentIntegration, c: T) => string | null | undefined,
  label: string,
): Deeplink[] {
  const links: Deeplink[] = [];
  for (const a of registry) {
    if (!a.isConfigured()) continue;
    const url = capability(a, ctx);
    if (typeof url === 'string' && url.length > 0) {
      links.push({ integrationId: a.id, integrationName: a.name, label, url });
    }
  }
  return links;
}

export function getServiceDashboardLinks(service: ServiceContext): Deeplink[] {
  return collect(
    service,
    (a, s) => (a.serviceDashboardUrl ? a.serviceDashboardUrl(s) : null),
    'Open in',
  );
}

export function getRepositoryLinks(repo: RepositoryContext): Deeplink[] {
  return collect(
    repo,
    (a, r) => (a.repositoryUrl ? a.repositoryUrl(r) : null),
    'Repo',
  );
}

export function getDeploymentLinks(deployment: DeploymentContext): Deeplink[] {
  return collect(
    deployment,
    (a, d) => (a.deploymentUrl ? a.deploymentUrl(d) : null),
    'Console',
  );
}

export function getMonitorLinks(monitor: MonitorContext): Deeplink[] {
  return collect(
    monitor,
    (a, m) => (a.monitorUrl ? a.monitorUrl(m) : null),
    'Monitor',
  );
}

export function getPageOnCallLinks(
  person: PersonContext,
  service: ServiceContext,
): Deeplink[] {
  return collect(
    { person, service },
    (a, ctx) => (a.pageOnCallUrl ? a.pageOnCallUrl(ctx.person, ctx.service) : null),
    'Page',
  );
}

export function getDeclareIncidentLinks(service: ServiceContext): Deeplink[] {
  return collect(
    service,
    (a, s) => (a.declareIncidentUrl ? a.declareIncidentUrl(s) : null),
    'Declare in',
  );
}

export function getTeamChannelLinks(team: TeamContext): Deeplink[] {
  return collect(
    team,
    (a, t) => (a.teamChannelUrl ? a.teamChannelUrl(t) : null),
    'Channel',
  );
}
