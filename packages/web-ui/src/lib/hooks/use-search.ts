'use client';

import { useQuery } from '@tanstack/react-query';
import { searchEntities, type EntitySourceFilter, type SearchResult } from '@/lib/api';

export function useSearch(query: string, source?: EntitySourceFilter) {
  // Cache key includes the source filter so two callers that pass different
  // filters don't share the wrong result set.
  return useQuery<SearchResult[]>({
    queryKey: ['search', query, source?.sourceSystem ?? '', source?.sourceConnectorId ?? ''],
    queryFn: () => searchEntities(query, source),
    enabled: query.length >= 2,
    retry: 1,
  });
}
