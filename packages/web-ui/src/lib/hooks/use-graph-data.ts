'use client';

import { useQuery } from '@tanstack/react-query';
import {
  fetchBlastRadius,
  fetchEntityClaims,
  fetchNeighborhood,
  fetchGraphOverview,
  fetchGraphSources,
  fetchConnectors,
  type Connector,
  type EntityClaims,
  type EntitySourceFilter,
  type GraphData,
  type GraphSourceInfo,
} from '@/lib/api';

export function useGraphData(nodeId?: string, depth: number = 2) {
  return useQuery<GraphData>({
    queryKey: ['graph-neighborhood', nodeId, depth],
    queryFn: () => fetchNeighborhood(nodeId!, depth),
    enabled: !!nodeId,
    retry: 1,
  });
}

export function useInitialGraphData(source?: EntitySourceFilter) {
  return useQuery<GraphData>({
    queryKey: ['graph-initial', source?.sourceSystem ?? '', source?.sourceConnectorId ?? ''],
    queryFn: () => fetchGraphOverview(100, source),
    retry: 1,
  });
}

export function useCatalogEntities(limit: number = 500, source?: EntitySourceFilter) {
  return useQuery<GraphData>({
    queryKey: [
      'catalog-overview',
      limit,
      source?.sourceSystem ?? '',
      source?.sourceConnectorId ?? '',
    ],
    queryFn: () => fetchGraphOverview(limit, source),
    retry: 1,
  });
}

export function useBlastRadius(nodeId?: string, depth: number = 3, enabled: boolean = true) {
  return useQuery<GraphData>({
    queryKey: ['blast-radius', nodeId, depth],
    queryFn: () => fetchBlastRadius(nodeId!, depth),
    enabled: !!nodeId && enabled,
    retry: 1,
  });
}

// Keyed `['claims', nodeId]` to match the verify mutation's cache
// invalidation in `claim-list.tsx`, so an inline verify refreshes this query.
export function useEntityClaims(nodeId?: string) {
  return useQuery<EntityClaims>({
    queryKey: ['claims', nodeId],
    queryFn: () => fetchEntityClaims(nodeId!),
    enabled: !!nodeId,
    retry: 1,
  });
}

export function useGraphSources() {
  return useQuery<GraphSourceInfo[]>({
    queryKey: ['graph-sources'],
    queryFn: fetchGraphSources,
    retry: 1,
  });
}

// Shared connector-list cache — the /connectors page already fetches this,
// but the catalog/explore source pill needs it too. Single React Query key
// means both surfaces share the same network round-trip.
export function useConnectorsList() {
  return useQuery<Connector[]>({
    queryKey: ['connectors-list'],
    queryFn: fetchConnectors,
    retry: 1,
  });
}
