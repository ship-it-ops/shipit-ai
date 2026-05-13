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
