import { clientConfig } from './client-config';

const API_URL = clientConfig.api.url;

/** Fired when a backend request returns 401 — the auth provider listens
 * for this and routes to /login instead of every consumer reimplementing
 * the redirect. */
export const AUTH_REQUIRED_EVENT = 'shipit:auth-required';

/**
 * Wrapped `fetch` that adds `credentials: 'include'` so the session
 * cookie round-trips on every API call, and dispatches a global event
 * on 401 so the auth provider can redirect to /login centrally.
 *
 * Every fetch in this file should go through this helper. Direct
 * `fetch()` calls won't send the session cookie cross-origin and won't
 * notify the redirect handler on auth failure.
 */
async function fetchApi(input: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(input, { ...init, credentials: 'include' });
  if (response.status === 401 && typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(AUTH_REQUIRED_EVENT));
  }
  return response;
}

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  staleness: number;
  lastSync: string;
  healthScore: number;
  nodesByLabel: Record<string, number>;
}

// ── Connector domain types ────────────────────────────────────────────────
// Mirror what the API server returns from /api/connectors. Kept separate
// from `ConnectorInfo` (the card-friendly summary computed via
// `connectorInfo()`) so the rich form data needed by the wizard/drawer
// doesn't bleed into the card component, and the card can be updated
// independently of the API shape.

export interface ConnectorScope {
  repos: { include: string[]; exclude: string[] };
  teams: { include: string[]; exclude: string[] };
  cappedAt: number | null;
  cappedAcknowledged: boolean;
}

export interface ConnectorEntities {
  repository: boolean;
  team: boolean;
  pipeline: boolean;
  codeowners: boolean;
  environment: boolean;
  deployment: boolean;
  branchProtection: boolean;
  workflowRun: boolean;
}

export interface ConnectorRun {
  startedAt: string;
  durationMs: number;
  status: 'success' | 'partial' | 'failed';
  entitiesSynced: number;
  errors: string[];
}

// Per-connector App identity. When absent the connector inherits the
// global App configured via env vars on the API server; when present it
// overrides field-by-field (e.g. you can change just the private key path
// while keeping the same App ID).
export interface ConnectorAppOverride {
  id?: string;
  privateKeyPath?: string;
}

export interface GitHubConnector {
  id: string;
  type: 'github';
  enabled: boolean;
  name: string;
  installationId: string;
  org: string;
  schedule: string;
  scope: ConnectorScope;
  entities: ConnectorEntities;
  lastRuns: ConnectorRun[];
  app?: ConnectorAppOverride;
}

export type Connector = GitHubConnector;

export interface SyncRuntimeStatus {
  connectorId: string;
  state: 'idle' | 'running' | 'failed' | 'degraded';
  startedAt?: string;
  lastError?: string;
  rateLimitRemaining?: number;
}

// Card-friendly summary derived from a `Connector` plus optional live status.
// The card component reads only these fields — keeping it stable as the
// underlying shape evolves.
export interface ConnectorInfo {
  id: string;
  name: string;
  type: string;
  status: 'healthy' | 'degraded' | 'failed' | 'not_connected';
  lastSync: string | null;
  entityCount: number;
  nextSync: string | null;
}

export function connectorInfo(c: Connector, runtime?: SyncRuntimeStatus | null): ConnectorInfo {
  const lastRun = c.lastRuns[0];
  // Derivation priority:
  //   1. Disabled → not_connected (always, regardless of any other signal).
  //   2. Runtime state — overrides cold storage because it catches in-
  //      flight syncs (`running`) and post-sync degraded/failed states
  //      that haven't been written to lastRuns yet.
  //   3. Latest run outcome — cold but durable across restarts.
  //   4. Fallback for enabled connectors with no runs yet: show as
  //      degraded (visually "syncing") rather than not_connected. A
  //      freshly-created connector with an in-flight or pending sync
  //      shouldn't appear "disconnected" — that label is reserved for
  //      explicitly-disabled connectors.
  let status: ConnectorInfo['status'];
  if (!c.enabled) {
    status = 'not_connected';
  } else if (runtime?.state === 'running') {
    // Maps to the DS `syncing` chip via the card's statusMap.
    status = 'degraded';
  } else if (runtime?.state === 'failed') {
    status = 'failed';
  } else if (runtime?.state === 'degraded') {
    status = 'degraded';
  } else if (lastRun?.status === 'failed') {
    status = 'failed';
  } else if (lastRun?.status === 'partial') {
    status = 'degraded';
  } else if (lastRun?.status === 'success') {
    status = 'healthy';
  } else {
    // Enabled, no runtime signal, no runs recorded yet — the freshly-
    // created or freshly-queued state. Show as syncing (degraded) so
    // the user sees forward motion rather than a "disconnected" label
    // that suggests they have to do something.
    status = 'degraded';
  }
  return {
    id: c.id,
    name: c.name,
    type: c.type,
    status,
    lastSync: lastRun?.startedAt ?? null,
    entityCount: lastRun?.entitiesSynced ?? 0,
    nextSync: null,
  };
}

export interface SearchResult {
  id: string;
  name: string;
  label: string;
  canonicalId: string;
  owner?: string;
  lastSynced?: string;
}

export interface GraphNode {
  data: {
    id: string;
    label: string;
    name: string;
    type: string;
    tier?: number;
    owner?: string;
    environment?: string;
    [key: string]: unknown;
  };
}

export interface GraphEdge {
  data: {
    id: string;
    source: string;
    target: string;
    type: string;
    [key: string]: unknown;
  };
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** True when blast-radius hit the server-side node cap. */
  truncated?: boolean;
}

export interface ActivityEvent {
  id: string;
  type: 'sync' | 'merge' | 'schema_change' | 'connector_added';
  message: string;
  connector?: string;
  timestamp: string;
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  // Only advertise a JSON content-type when there's actually a body to encode.
  // Fastify's JSON parser rejects bodyless POSTs with `Content-Type: application/json`
  // as 400 "Body cannot be empty when content-type is set to 'application/json'".
  const headers = new Headers(options?.headers);
  if (options?.body != null && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  const res = await fetchApi(`${API_URL}${path}`, { ...options, headers });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function fetchGraphStats(): Promise<GraphStats> {
  return apiFetch<GraphStats>('/api/graph/stats');
}

// ── Personal access tokens (auth.enabled deployments only) ────────────────

export interface AccessTokenSummary {
  id: string;
  name: string;
  scopes: ReadonlyArray<string>;
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

export interface MintedToken {
  id: string;
  name: string;
  /** Plaintext value returned exactly once on create — never persisted. */
  token: string;
  scopes: ReadonlyArray<string>;
  createdAt: string;
}

export async function fetchTokens(): Promise<AccessTokenSummary[]> {
  const { tokens } = await apiFetch<{ tokens: AccessTokenSummary[] }>('/api/tokens');
  return tokens;
}

export async function createToken(args: {
  name: string;
  scopes?: ReadonlyArray<string>;
}): Promise<MintedToken> {
  return apiFetch<MintedToken>('/api/tokens', {
    method: 'POST',
    body: JSON.stringify({ name: args.name, scopes: args.scopes }),
  });
}

export async function revokeToken(id: string): Promise<void> {
  const res = await fetchApi(`${API_URL}/api/tokens/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`revokeToken failed: ${res.status}`);
  }
}

export async function fetchConnectors(): Promise<Connector[]> {
  return apiFetch<Connector[]>('/api/connectors');
}

export interface ConnectorWithHash {
  connector: Connector;
  hash: string | null;
}

export async function fetchConnector(id: string): Promise<ConnectorWithHash> {
  const res = await fetchApi(`${API_URL}/api/connectors/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`fetchConnector: ${res.status}`);
  const connector = (await res.json()) as Connector;
  return { connector, hash: parseEtag(res.headers.get('ETag')) };
}

export interface CreateConnectorInput {
  id: string;
  type: 'github';
  name: string;
  installationId: string;
  org: string;
  enabled?: boolean;
  schedule?: string;
  scope?: ConnectorScope;
  entities?: ConnectorEntities;
  app?: ConnectorAppOverride;
}

export async function createConnector(input: CreateConnectorInput): Promise<Connector> {
  const res = await fetchApi(`${API_URL}/api/connectors`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Create failed: ${res.status}`);
  }
  return (await res.json()) as Connector;
}

export interface UpdateConnectorInput {
  enabled?: boolean;
  name?: string;
  schedule?: string;
  scope?: ConnectorScope;
  entities?: ConnectorEntities;
  // `null` clears the override (revert to global App); object replaces it;
  // omitted leaves the existing value alone.
  app?: ConnectorAppOverride | null;
}

export async function patchConnector(
  id: string,
  input: UpdateConnectorInput,
  ifMatch?: string,
): Promise<ConnectorWithHash> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ifMatch) headers['If-Match'] = `"${ifMatch}"`;
  const res = await fetchApi(`${API_URL}/api/connectors/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(input),
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
      serverHash?: string;
    };
    throw new EtagConflictError(
      body.error?.message ?? 'Connector was modified by another writer.',
      body.serverHash ?? '',
    );
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Update failed: ${res.status}`);
  }
  const connector = (await res.json()) as Connector;
  return { connector, hash: parseEtag(res.headers.get('ETag')) };
}

export async function deleteConnector(id: string, ifMatch?: string): Promise<void> {
  const headers: Record<string, string> = {};
  if (ifMatch) headers['If-Match'] = `"${ifMatch}"`;
  const res = await fetchApi(`${API_URL}/api/connectors/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers,
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
      serverHash?: string;
    };
    throw new EtagConflictError(
      body.error?.message ?? 'Connector was modified by another writer.',
      body.serverHash ?? '',
    );
  }
  if (!res.ok && res.status !== 204) {
    throw new Error(`Delete failed: ${res.status}`);
  }
}

export interface ProbeResult {
  ok: boolean;
  code?: string;
  message?: string;
  installation?: {
    id: string;
    account: string | null;
    accountType: string | null;
    repoCount: number;
  };
  suggestedOrg?: string;
  sampleRepos?: Array<{ name: string; private: boolean; archived: boolean }>;
  // Which App credentials the probe ended up using. `overridden: true` is
  // the wizard's confirmation that the advanced panel actually took effect.
  app?: { id: string | null; overridden: boolean };
}

export interface ProbeInput {
  installationId: string;
  suggestedOrg?: string;
  app?: ConnectorAppOverride;
}

export async function probeConnector(input: ProbeInput): Promise<ProbeResult> {
  const res = await fetchApi(`${API_URL}/api/connectors/probe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  // Probe deliberately returns 200 on ok and 4xx on structured failure so we
  // can't tell from the status alone; trust the body's `ok` boolean.
  const body = (await res.json().catch(() => ({}))) as ProbeResult;
  return body;
}

export async function fetchConnectorRuns(
  id: string,
): Promise<{ connectorId: string; runs: ConnectorRun[] }> {
  return apiFetch(`/api/connectors/${encodeURIComponent(id)}/runs`);
}

export async function fetchConnectorStatus(id: string): Promise<SyncRuntimeStatus> {
  return apiFetch(`/api/connectors/${encodeURIComponent(id)}/status`);
}

// ── Global GitHub App ─────────────────────────────────────────────────────
// Wizard reads this on open to decide whether to prompt for a shared App
// or offer the existing one. Returns null path/id when nothing is set.
export interface GitHubAppStatus {
  configured: boolean;
  id: string | null;
  privateKeyPath: string | null;
}

export interface GitHubAppStatusWithHash {
  status: GitHubAppStatus;
  hash: string | null;
}

export async function fetchGitHubAppStatus(): Promise<GitHubAppStatusWithHash> {
  const res = await fetchApi(`${API_URL}/api/connectors/github/app`);
  if (!res.ok) {
    // 503 means the service isn't wired (no global App config object on
    // the server) — treat as "not configured" rather than throwing so
    // the wizard can still drive the user through manual env-var setup.
    if (res.status === 503) {
      return { status: { configured: false, id: null, privateKeyPath: null }, hash: null };
    }
    throw new Error(`fetchGitHubAppStatus: ${res.status}`);
  }
  const status = (await res.json()) as GitHubAppStatus;
  return { status, hash: parseEtag(res.headers.get('ETag')) };
}

// ── GitHub App manifest flow ──────────────────────────────────────────────
// The flow has three URLs:
//   1. /api/connectors/github/manifest/launch — same-origin HTML page
//      the wizard opens in a new tab. The page contains an auto-
//      submitting form that POSTs the manifest JSON to github.com. The
//      server mints + embeds the state token in the form's action URL.
//   2. github.com/.../settings/apps/new — GitHub renders a pre-filled
//      App-creation page from the POSTed manifest. User clicks Create.
//   3. /api/connectors/github/app-manifest-callback — GitHub redirects
//      the user here with `code` + `state`. We exchange the code for
//      credentials and persist.
//
// GitHub does NOT support a `manifest_url=` query param that it would
// fetch — only a POST form transports the manifest body. The earlier
// implementation that tried `manifest_url=...` produced an empty App-
// creation form because GitHub silently ignored the param.

export function buildManifestLaunchUrl(args: {
  ownerOrg?: string;
  // 'global' writes credentials to connectors.github.app.* (shared App).
  // 'instance' stashes them in a pending-instance slot keyed by `nonce`
  // for the wizard's per-org card to claim and attach to a connector
  // instance's `app` override. Default is global to preserve back-compat
  // with the existing shared-mode flow.
  target?: 'global' | 'instance';
  nonce?: string;
}): string {
  const qs = new URLSearchParams();
  if (args.ownerOrg?.trim()) qs.set('owner', args.ownerOrg.trim());
  if (args.target === 'instance') {
    qs.set('target', 'instance');
    if (args.nonce) qs.set('nonce', args.nonce);
  }
  const query = qs.toString();
  return `${API_URL}/api/connectors/github/manifest/launch${query ? `?${query}` : ''}`;
}

// Wizard's per-org card polls this with its nonce while the user is in
// the GitHub tab. 404 = not ready yet (keep polling); 200 = creds
// stashed by the manifest callback, ready to claim. Single-use on the
// server side — once claimed the wizard owns the credentials.
export interface PendingInstanceApp {
  appId: string;
  appName: string;
  installUrl: string;
  privateKeyPath: string;
  webhookSecretPath: string;
}

export async function fetchPendingInstanceApp(nonce: string): Promise<PendingInstanceApp | null> {
  const res = await fetchApi(
    `${API_URL}/api/connectors/github/manifest/pending-instance/${encodeURIComponent(nonce)}`,
  );
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`fetchPendingInstanceApp failed: ${res.status}`);
  }
  return (await res.json()) as PendingInstanceApp;
}

// ── GitHub App installations picker ─────────────────────────────────────
// Powers the wizard's Connect step: rather than asking the user to paste
// an installation ID found by hand in GitHub's UI, the wizard renders
// the list returned here and lets them click an org. `usedByConnectorId`
// flags installations already wired to a connector so the picker can
// show a "Already used by X" pill and block duplicate creation.

export interface GitHubAppInstallation {
  id: number;
  account: {
    login: string;
    type: 'User' | 'Organization';
    avatarUrl: string;
  };
  targetType: 'User' | 'Organization';
  repositorySelection: 'all' | 'selected';
  usedByConnectorId: string | null;
}

export interface GitHubAppInstallationsResponse {
  appSlug: string;
  appName: string;
  installUrl: string;
  installations: GitHubAppInstallation[];
}

export class GitHubAppNotConfiguredError extends Error {
  constructor() {
    super('No global GitHub App is configured yet.');
    this.name = 'GitHubAppNotConfiguredError';
  }
}

export async function fetchGitHubAppInstallations(): Promise<GitHubAppInstallationsResponse> {
  const res = await fetchApi(`${API_URL}/api/connectors/github/installations`);
  if (res.status === 404) {
    // App not configured yet — first-run state. Caller (the wizard) maps
    // this to the "create an App first" copy on Step 1 rather than to a
    // generic error banner.
    throw new GitHubAppNotConfiguredError();
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `fetchGitHubAppInstallations failed: ${res.status}`);
  }
  return (await res.json()) as GitHubAppInstallationsResponse;
}

export async function updateGitHubApp(
  input: { id: string; privateKeyPath: string },
  ifMatch?: string,
): Promise<GitHubAppStatusWithHash> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (ifMatch) headers['If-Match'] = `"${ifMatch}"`;
  const res = await fetchApi(`${API_URL}/api/connectors/github/app`, {
    method: 'PUT',
    headers,
    body: JSON.stringify(input),
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
      serverHash?: string;
    };
    throw new EtagConflictError(
      body.error?.message ?? 'Global GitHub App was modified by another writer.',
      body.serverHash ?? '',
    );
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Update failed: ${res.status}`);
  }
  const status = (await res.json()) as GitHubAppStatus;
  return { status, hash: parseEtag(res.headers.get('ETag')) };
}

export async function searchEntities(query: string): Promise<SearchResult[]> {
  return apiFetch<SearchResult[]>(`/api/graph/search?q=${encodeURIComponent(query)}`);
}

export async function fetchNeighborhood(nodeId: string, depth: number = 2): Promise<GraphData> {
  return apiFetch<GraphData>(
    `/api/graph/neighborhood/${encodeURIComponent(nodeId)}?depth=${depth}`,
  );
}

export async function fetchBlastRadius(nodeId: string, depth: number = 3): Promise<GraphData> {
  return apiFetch<GraphData>(
    `/api/graph/blast-radius/${encodeURIComponent(nodeId)}?depth=${depth}`,
  );
}

export async function fetchGraphOverview(limit: number = 100): Promise<GraphData> {
  return apiFetch<GraphData>(`/api/graph/overview?limit=${limit}`);
}

export async function triggerSync(connectorId: string): Promise<void> {
  await apiFetch(`/api/connectors/${encodeURIComponent(connectorId)}/sync`, { method: 'POST' });
}

export async function fetchActivity(): Promise<ActivityEvent[]> {
  return apiFetch<ActivityEvent[]>('/api/activity');
}

// -- Incident events --------------------------------------------------------

/**
 * Records a single Incident-Mode dashboard view. Fire-and-forget — failures
 * never block the page from rendering. Used by Phase 2 adoption analytics.
 */
export async function recordIncidentView(serviceId: string): Promise<void> {
  try {
    await fetchApi(`${API_URL}/api/incident-events/view`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceId }),
      keepalive: true,
    });
  } catch {
    // Intentional: telemetry must never crash the dashboard.
  }
}

// -- Query Playground --------------------------------------------------------

export interface CypherQueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  executionTimeMs: number;
  truncated: boolean;
  rowLimit: number;
}

export interface CypherApiError {
  code: 'WRITE_BLOCKED' | 'QUERY_TIMEOUT' | 'VALIDATION_ERROR' | 'CYPHER_ERROR';
  message: string;
  keyword?: string;
}

// -- Claim Explorer ----------------------------------------------------------

export interface PropertyClaim {
  property_key: string;
  value: unknown;
  source: string;
  source_id: string;
  ingested_at: string;
  confidence: number;
  evidence: string | null;
}

export type ResolutionStrategy =
  | 'MANUAL_OVERRIDE_FIRST'
  | 'HIGHEST_CONFIDENCE'
  | 'AUTHORITATIVE_ORDER'
  | 'LATEST_TIMESTAMP'
  | 'MERGE_SET';

export interface ResolvedProperty {
  property_key: string;
  effective_value: unknown;
  winning_claim: PropertyClaim | null;
  strategy: ResolutionStrategy;
  has_conflict: boolean;
  claims: PropertyClaim[];
}

export interface EntityClaims {
  entityId: string;
  label: string;
  name: string;
  properties: ResolvedProperty[];
}

export interface ConflictRow {
  entityId: string;
  name: string;
  label: string;
  tier: number | null;
  propertyKey: string;
  sources: string[];
  values: unknown[];
  claimCount: number;
}

export async function fetchEntityClaims(entityId: string): Promise<EntityClaims> {
  return apiFetch<EntityClaims>(`/api/claims/${encodeURIComponent(entityId)}`);
}

// -- Schema Editor -----------------------------------------------------------

export interface SchemaPropertyDef {
  type: string;
  required?: boolean;
  resolution_strategy: ResolutionStrategy;
  enum?: string[];
  description?: string;
}

export interface SchemaNodeTypeDef {
  description: string;
  properties: Record<string, SchemaPropertyDef>;
  constraints?: { unique_key?: string };
}

export interface SchemaRelTypeDef {
  from: string;
  to: string;
  cardinality: '1:1' | '1:N' | 'N:1' | 'N:M';
  properties?: Record<string, SchemaPropertyDef>;
  description?: string;
  /** Behavioral category — see @shipit-ai/shared `RelTypeSemantics`. */
  semantics?: 'ownership';
}

export interface ShipItSchema {
  version: string;
  mode: 'full' | 'simple';
  node_types: Record<string, SchemaNodeTypeDef>;
  relationship_types: Record<string, SchemaRelTypeDef>;
  resolution_defaults?: Record<string, ResolutionStrategy>;
}

export interface SchemaSnapshot {
  version: string;
  actor: string;
  size: number;
}

export interface SchemaDiff {
  added: { node_types: string[]; relationship_types: string[] };
  removed: { node_types: string[]; relationship_types: string[] };
  changed: Array<{
    kind: 'node_type' | 'relationship_type';
    name: string;
    added_properties: string[];
    removed_properties: string[];
    changed_properties: Array<{ name: string; field: string; before: unknown; after: unknown }>;
    structural_changes: Array<{ field: string; before: unknown; after: unknown }>;
  }>;
}

export interface MigrationImpact {
  kind:
    | 'remove_node_type'
    | 'remove_property'
    | 'remove_relationship_type'
    | 'rel_structural_change'
    | 'change_unique_key'
    | 'add_required_property';
  target: string;
  property?: string;
  summary: string;
  affected: number | null;
  samples: string[];
}

export interface MigrationPreview {
  impacts: MigrationImpact[];
  skipped: boolean;
}

/**
 * Thrown by `saveSchemaYaml` when the server returns 409 — the schema file
 * was modified between the caller's read and write. `serverHash` lets the
 * UI present "discard + reload" / "keep editing" without a full refetch.
 */
// Generic ETag mismatch — thrown by any endpoint that uses If-Match
// optimistic concurrency. Carries the current server hash so the UI can
// show a "discard local + reload" affordance without an extra GET.
export class EtagConflictError extends Error {
  readonly serverHash: string;
  constructor(message: string, serverHash: string) {
    super(message);
    this.name = 'EtagConflictError';
    this.serverHash = serverHash;
  }
}

// Kept as a subclass so existing `instanceof SchemaConflictError` checks in
// the schema editor still work after the rename. New surfaces should throw
// EtagConflictError directly.
export class SchemaConflictError extends EtagConflictError {
  constructor(message: string, serverHash: string) {
    super(message, serverHash);
    this.name = 'SchemaConflictError';
  }
}

/** Parsed `ETag` header value, sans the quoted wrapping. */
function parseEtag(header: string | null): string | null {
  if (!header) return null;
  return header.replace(/^W\//, '').replace(/^"|"$/g, '');
}

export interface SchemaWithHash {
  schema: ShipItSchema;
  hash: string | null;
}

export async function fetchSchema(): Promise<SchemaWithHash> {
  const res = await fetchApi(`${API_URL}/api/schema`);
  if (!res.ok) throw new Error(`fetchSchema: ${res.status}`);
  const schema = (await res.json()) as ShipItSchema;
  return { schema, hash: parseEtag(res.headers.get('ETag')) };
}

export async function fetchSchemaHistory(): Promise<SchemaSnapshot[]> {
  return apiFetch<SchemaSnapshot[]>('/api/schema/history');
}

export async function saveSchemaYaml(yaml: string, ifMatch?: string): Promise<SchemaWithHash> {
  const headers: Record<string, string> = { 'Content-Type': 'text/yaml' };
  if (ifMatch) headers['If-Match'] = `"${ifMatch}"`;
  const res = await fetchApi(`${API_URL}/api/schema?actor=web-ui`, {
    method: 'PUT',
    headers,
    body: yaml,
  });
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string };
      serverHash?: string;
    };
    throw new SchemaConflictError(
      body.error?.message ?? 'Schema was modified by another writer.',
      body.serverHash ?? '',
    );
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Save failed: ${res.status}`);
  }
  const schema = (await res.json()) as ShipItSchema;
  return { schema, hash: parseEtag(res.headers.get('ETag')) };
}

export async function diffSchemaYaml(yaml: string): Promise<SchemaDiff> {
  const res = await fetchApi(`${API_URL}/api/schema/diff`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/yaml' },
    body: yaml,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Diff failed: ${res.status}`);
  }
  return (await res.json()) as SchemaDiff;
}

export async function migrationPreview(yaml: string): Promise<MigrationPreview> {
  const res = await fetchApi(`${API_URL}/api/schema/migration-preview`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/yaml' },
    body: yaml,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Migration preview failed: ${res.status}`);
  }
  return (await res.json()) as MigrationPreview;
}

export async function rollbackSchema(version: string): Promise<SchemaWithHash> {
  const res = await fetchApi(`${API_URL}/api/schema/rollback?actor=web-ui`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Rollback failed: ${res.status}`);
  }
  const schema = (await res.json()) as ShipItSchema;
  return { schema, hash: parseEtag(res.headers.get('ETag')) };
}

// -- Team Dashboard ----------------------------------------------------------

export interface TeamSummary {
  id: string;
  name: string;
  slug: string;
  email: string | null;
  description: string | null;
  ownedCount: number;
  memberCount: number;
  onCallCount: number;
}

export interface TeamOwnedEntity {
  id: string;
  name: string;
  label: string;
  tier: number | null;
  environment?: string;
}

export interface TeamMember {
  id: string;
  name: string;
  login: string;
  role: string | null;
}

export interface OnCallAssignment {
  serviceId: string;
  serviceName: string;
  personId: string;
  personName: string;
}

export interface TeamDetail extends TeamSummary {
  services: TeamOwnedEntity[];
  repositories: TeamOwnedEntity[];
  deployments: TeamOwnedEntity[];
  members: TeamMember[];
  onCall: OnCallAssignment[];
}

// -- Reconciliation ----------------------------------------------------------

export type CandidateStatus = 'pending' | 'confirmed' | 'rejected' | 'distinct';

export interface ReconciliationCandidate {
  id: string;
  status: CandidateStatus;
  leftId: string;
  leftName: string;
  leftSource: string | null;
  rightId: string;
  rightName: string;
  rightSource: string | null;
  label: string;
  confidence: number;
  scoreBreakdown: { name: number; namespace: number; tags: number; labels: number };
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

export interface CandidateDetail extends ReconciliationCandidate {
  leftProperties: Record<string, unknown>;
  rightProperties: Record<string, unknown>;
}

export interface MergeEventSummary {
  id: string;
  sourceId: string;
  targetId: string;
  sourceName: string;
  targetName: string;
  actor: string;
  timestamp: string;
  method: 'primary_key' | 'linking_key' | 'fuzzy' | 'manual';
  confidence: number;
}

export interface ReconciliationStats {
  pending: number;
  recentMerges: number;
  lastScanAt: string | null;
}

export async function fetchCandidates(
  status: CandidateStatus = 'pending',
): Promise<ReconciliationCandidate[]> {
  return apiFetch<ReconciliationCandidate[]>(`/api/reconciliation/candidates?status=${status}`);
}

export async function fetchCandidate(id: string): Promise<CandidateDetail> {
  return apiFetch<CandidateDetail>(`/api/reconciliation/candidates/${encodeURIComponent(id)}`);
}

export async function confirmMerge(id: string): Promise<MergeEventSummary> {
  return apiFetch<MergeEventSummary>(
    `/api/reconciliation/candidates/${encodeURIComponent(id)}/confirm`,
    {
      method: 'POST',
    },
  );
}

export async function rejectCandidate(id: string): Promise<void> {
  await apiFetch(`/api/reconciliation/candidates/${encodeURIComponent(id)}/reject`, {
    method: 'POST',
  });
}

export async function markCandidateDistinct(id: string): Promise<void> {
  await apiFetch(`/api/reconciliation/candidates/${encodeURIComponent(id)}/distinct`, {
    method: 'POST',
  });
}

export async function triggerScan(): Promise<{ created: number }> {
  return apiFetch<{ created: number }>(`/api/reconciliation/scan`, { method: 'POST' });
}

export async function fetchMerges(): Promise<MergeEventSummary[]> {
  return apiFetch<MergeEventSummary[]>('/api/reconciliation/merges');
}

export async function splitMerge(mergeId: string): Promise<void> {
  await apiFetch(`/api/reconciliation/merges/${encodeURIComponent(mergeId)}/split`, {
    method: 'POST',
  });
}

export async function fetchReconciliationStats(): Promise<ReconciliationStats> {
  return apiFetch<ReconciliationStats>('/api/reconciliation/stats');
}

export interface McpServerInfo {
  authRequired: boolean;
  transport: 'stdio';
}

export async function fetchMcpInfo(): Promise<McpServerInfo> {
  // Only `authRequired` and `transport` are read by the UI — the endpoint
  // also returns the tool catalog but the page renders that from a static
  // import to keep first paint zero-network.
  return apiFetch<McpServerInfo>('/api/mcp/info');
}

export async function fetchTeams(): Promise<TeamSummary[]> {
  return apiFetch<TeamSummary[]>('/api/teams');
}

export async function fetchTeam(id: string): Promise<TeamDetail> {
  return apiFetch<TeamDetail>(`/api/teams/${encodeURIComponent(id)}`);
}

export async function fetchConflicts(
  filters: { label?: string; tier?: number; limit?: number } = {},
): Promise<ConflictRow[]> {
  const params = new URLSearchParams();
  if (filters.label) params.set('label', filters.label);
  if (filters.tier !== undefined) params.set('tier', String(filters.tier));
  if (filters.limit !== undefined) params.set('limit', String(filters.limit));
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiFetch<ConflictRow[]>(`/api/conflicts${qs}`);
}

// -- Query Playground (kept below for grouping) ------------------------------

export async function runCypherQuery(
  cypher: string,
  params: Record<string, unknown> = {},
): Promise<CypherQueryResult> {
  const res = await fetchApi(`${API_URL}/api/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cypher, params }),
  });
  const body = (await res.json()) as CypherQueryResult | { error: CypherApiError };
  if (!res.ok) {
    const err = (body as { error: CypherApiError }).error;
    const e = new Error(err?.message ?? `Query failed: ${res.status}`) as Error & {
      code?: string;
      keyword?: string;
    };
    e.code = err?.code;
    e.keyword = err?.keyword;
    throw e;
  }
  return body as CypherQueryResult;
}
