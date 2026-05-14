/**
 * Pluggable integration adapter contract.
 *
 * Each adapter answers a fixed set of questions about how to deeplink into
 * a specific external system (PagerDuty, Datadog, Slack, GitHub, etc.). The
 * dashboard never hard-codes a URL — it asks the registry, which asks every
 * configured adapter, and renders only the ones that resolve.
 *
 * Adapters self-report via `isConfigured()` so a customer running Datadog
 * without PagerDuty just doesn't see the "Page on-call" button — no broken
 * link, no error, no "configure your account" placeholder.
 */

/** Minimum service shape an adapter receives to build URLs. */
export interface ServiceContext {
  id: string;
  name: string;
  /** Datadog APM service name, populated by the EMITS_TELEMETRY_AS edge. */
  ddService?: string;
  /** Tier (1..3) — only some adapters use this (e.g., PagerDuty service map). */
  tier?: number;
  /** Owner team slug if the catalog has it. */
  ownerSlug?: string;
}

/** Person shape for paging actions. */
export interface PersonContext {
  id: string;
  name: string;
  login?: string;
  email?: string;
}

/** Team shape for channel/email actions. */
export interface TeamContext {
  id: string;
  name: string;
  slug: string;
  email?: string | null;
}

/** Monitor shape for monitor deeplinks. */
export interface MonitorContext {
  id: string;
  name: string;
  /** Datadog monitor id if seeded by the connector. */
  ddMonitorId?: string;
  /** Native source URL if the connector captured it. */
  url?: string;
}

/** Repository shape for GitHub-style deeplinks. */
export interface RepositoryContext {
  id: string;
  name: string;
  url?: string;
  defaultBranch?: string;
}

/** Deployment shape for k8s/console-style deeplinks. */
export interface DeploymentContext {
  id: string;
  name: string;
  cluster?: string;
  namespace?: string;
  environment?: string;
}

/**
 * Resolved deeplink. `integrationId` lets the UI render an icon + tone per
 * adapter; `null` URLs are filtered before reaching the component.
 */
export interface Deeplink {
  integrationId: string;
  integrationName: string;
  label: string;
  url: string;
}

/**
 * Adapter contract. Every method is optional — an adapter that only knows
 * how to build a service dashboard URL just implements that one.
 */
export interface IncidentIntegration {
  id: string;
  name: string;
  /** True when env / config provides everything this adapter needs to build URLs. */
  isConfigured(): boolean;
  /** Primary "open this service in {tool}" link — top-of-page button. */
  serviceDashboardUrl?(service: ServiceContext): string | null;
  /** Page the named on-call person for the named service. */
  pageOnCallUrl?(person: PersonContext, service: ServiceContext): string | null;
  /** Declare a new incident pre-populated with this service. */
  declareIncidentUrl?(service: ServiceContext): string | null;
  /** Open the team's channel or jump to the team. */
  teamChannelUrl?(team: TeamContext): string | null;
  /** Open the repository view for code-context. */
  repositoryUrl?(repo: RepositoryContext): string | null;
  /** Open this deployment's console (k8s, ECS, etc.). */
  deploymentUrl?(deployment: DeploymentContext): string | null;
  /** Open this monitor's definition / firing history. */
  monitorUrl?(monitor: MonitorContext): string | null;
}
