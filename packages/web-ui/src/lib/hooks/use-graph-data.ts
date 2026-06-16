'use client';

import { useQuery } from '@tanstack/react-query';
import {
  fetchBlastRadius,
  fetchEntityClaims,
  fetchNeighborhood,
  fetchGraphOverview,
  type EntityClaims,
  type GraphData,
} from '@/lib/api';

export function useGraphData(nodeId?: string, depth: number = 2) {
  return useQuery<GraphData>({
    queryKey: ['graph-neighborhood', nodeId, depth],
    queryFn: () => fetchNeighborhood(nodeId!, depth),
    enabled: !!nodeId,
    retry: 1,
  });
}

export function useInitialGraphData() {
  return useQuery<GraphData>({
    queryKey: ['graph-initial'],
    queryFn: () => fetchGraphOverview(),
    retry: 1,
  });
}

export function useCatalogEntities(limit: number = 500) {
  return useQuery<GraphData>({
    queryKey: ['catalog-overview', limit],
    queryFn: () => fetchGraphOverview(limit),
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
