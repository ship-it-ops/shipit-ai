const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3001';

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  staleness: number;
  lastSync: string;
  healthScore: number;
  nodesByLabel: Record<string, number>;
}

export interface ConnectorInfo {
  id: string;
  name: string;
  type: string;
  status: 'healthy' | 'degraded' | 'failed' | 'not_connected';
  lastSync: string | null;
  entityCount: number;
  nextSync: string | null;
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
}

export interface ActivityEvent {
  id: string;
  type: 'sync' | 'merge' | 'schema_change' | 'connector_added';
  message: string;
  connector?: string;
  timestamp: string;
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    throw new Error(`API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export async function fetchGraphStats(): Promise<GraphStats> {
  return apiFetch<GraphStats>('/api/graph/stats');
}

export async function fetchConnectors(): Promise<ConnectorInfo[]> {
  return apiFetch<ConnectorInfo[]>('/api/connectors');
}

export async function searchEntities(query: string): Promise<SearchResult[]> {
  return apiFetch<SearchResult[]>(`/api/graph/search?q=${encodeURIComponent(query)}`);
}

export async function fetchNeighborhood(nodeId: string, depth: number = 2): Promise<GraphData> {
  return apiFetch<GraphData>(
    `/api/graph/neighborhood/${encodeURIComponent(nodeId)}?depth=${depth}`,
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
  }>;
}

export async function fetchSchema(): Promise<ShipItSchema> {
  return apiFetch<ShipItSchema>('/api/schema');
}

export async function fetchSchemaHistory(): Promise<SchemaSnapshot[]> {
  return apiFetch<SchemaSnapshot[]>('/api/schema/history');
}

export async function saveSchemaYaml(yaml: string): Promise<ShipItSchema> {
  const res = await fetch(`${API_URL}/api/schema?actor=web-ui`, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/yaml' },
    body: yaml,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Save failed: ${res.status}`);
  }
  return (await res.json()) as ShipItSchema;
}

export async function diffSchemaYaml(yaml: string): Promise<SchemaDiff> {
  const res = await fetch(`${API_URL}/api/schema/diff`, {
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

export async function rollbackSchema(version: string): Promise<ShipItSchema> {
  const res = await fetch(`${API_URL}/api/schema/rollback?actor=web-ui`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw new Error(body.error?.message ?? `Rollback failed: ${res.status}`);
  }
  return (await res.json()) as ShipItSchema;
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

export async function fetchCandidates(status: CandidateStatus = 'pending'): Promise<ReconciliationCandidate[]> {
  return apiFetch<ReconciliationCandidate[]>(`/api/reconciliation/candidates?status=${status}`);
}

export async function fetchCandidate(id: string): Promise<CandidateDetail> {
  return apiFetch<CandidateDetail>(`/api/reconciliation/candidates/${encodeURIComponent(id)}`);
}

export async function confirmMerge(id: string): Promise<MergeEventSummary> {
  return apiFetch<MergeEventSummary>(`/api/reconciliation/candidates/${encodeURIComponent(id)}/confirm`, {
    method: 'POST',
  });
}

export async function rejectCandidate(id: string): Promise<void> {
  await apiFetch(`/api/reconciliation/candidates/${encodeURIComponent(id)}/reject`, { method: 'POST' });
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
  const res = await fetch(`${API_URL}/api/query`, {
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
