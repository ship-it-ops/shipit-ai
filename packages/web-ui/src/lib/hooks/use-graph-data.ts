'use client';

import { useQuery } from '@tanstack/react-query';
import { fetchNeighborhood, fetchGraphOverview, type GraphData } from '@/lib/api';

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
