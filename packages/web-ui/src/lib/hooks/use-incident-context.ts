'use client';

import { useMemo } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { fetchEntityClaims, fetchTeam, type EntityClaims, type GraphData, type TeamDetail } from '../api';
import { useBlastRadius, useGraphData } from './use-graph-data';

/**
 * Composes the React Query hooks the incident dashboard needs and applies
 * dashboard-tuned defaults (longer staleTime, keep previous data across
 * service switches). Does NOT mutate the underlying hooks — those are
 * shared with /catalog/[id] and changing them would leak side effects
 * into a page that doesn't want them.
 *
 * The team-detail query auto-derives its key from the OWNS edge in the
 * neighborhood result, so the caller doesn't have to make two passes
 * through the hook.
 */

export interface IncidentContext {
  serviceId: string | undefined;
  neighborhood: ReturnType<typeof useGraphData>;
  blast: ReturnType<typeof useBlastRadius>;
  team: ReturnType<typeof useTeamForService>;
  claims: ReturnType<typeof useServiceClaims>;
}

function useTeamForService(teamId: string | undefined) {
  return useQuery<TeamDetail | null>({
    queryKey: ['team', teamId],
    queryFn: () => (teamId ? fetchTeam(teamId) : Promise.resolve(null)),
    enabled: !!teamId,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    retry: 1,
  });
}

function useServiceClaims(serviceId: string | undefined) {
  return useQuery<EntityClaims>({
    queryKey: ['entity-claims', serviceId],
    queryFn: () => fetchEntityClaims(serviceId!),
    enabled: !!serviceId,
    staleTime: 60_000,
    retry: 1,
  });
}

/**
 * Find the owning team id from a depth-1 neighborhood. Returns the source
 * of the first OWNS edge whose target is the service id.
 */
function ownerTeamIdOf(graph: GraphData | undefined, serviceId: string | undefined): string | undefined {
  if (!graph || !serviceId) return undefined;
  for (const e of graph.edges) {
    if (e.data.type === 'OWNS' && e.data.target === serviceId) {
      return String(e.data.source);
    }
  }
  return undefined;
}

export function useIncidentContext(serviceId: string | undefined): IncidentContext {
  const neighborhood = useGraphData(serviceId, 1);
  const blast = useBlastRadius(serviceId, 3, !!serviceId);
  const teamId = useMemo(
    () => ownerTeamIdOf(neighborhood.data, serviceId),
    [neighborhood.data, serviceId],
  );
  const team = useTeamForService(teamId);
  const claims = useServiceClaims(serviceId);
  return { serviceId, neighborhood, blast, team, claims };
}
