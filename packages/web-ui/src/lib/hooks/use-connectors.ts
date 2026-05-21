'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  createConnector,
  deleteConnector,
  fetchConnector,
  fetchConnectors,
  fetchConnectorRuns,
  fetchConnectorStatus,
  fetchGitHubAppStatus,
  fetchManifestState,
  patchConnector,
  probeConnector,
  triggerSync,
  updateGitHubApp,
  type Connector,
  type ConnectorWithHash,
  type CreateConnectorInput,
  type GitHubAppStatusWithHash,
  type UpdateConnectorInput,
} from '@/lib/api';

// List: poll-friendly cadence so the Connector Hub stays fresh without
// being chatty. Detail/drawer below uses a tighter interval since the user
// is actively watching it.
export function useConnectors() {
  return useQuery<Connector[]>({
    queryKey: ['connectors'],
    queryFn: fetchConnectors,
    retry: 1,
    refetchInterval: 30_000,
  });
}

export function useConnector(id: string | null) {
  return useQuery<ConnectorWithHash>({
    queryKey: ['connector', id],
    queryFn: () => fetchConnector(id as string),
    enabled: !!id,
    refetchInterval: 10_000,
  });
}

export function useConnectorRuns(id: string | null) {
  return useQuery({
    queryKey: ['connector-runs', id],
    queryFn: () => fetchConnectorRuns(id as string),
    enabled: !!id,
    refetchInterval: 15_000,
  });
}

export function useConnectorStatus(id: string | null) {
  return useQuery({
    queryKey: ['connector-status', id],
    queryFn: () => fetchConnectorStatus(id as string),
    enabled: !!id,
    refetchInterval: 5_000,
  });
}

export function useTriggerSync() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: triggerSync,
    onSuccess: (_data, id) => {
      // Invalidate both list and detail since either may render this
      // connector's status. Graph-stats refetches too because a manual sync
      // is the most common reason a user wants the dashboard to update.
      queryClient.invalidateQueries({ queryKey: ['connectors'] });
      queryClient.invalidateQueries({ queryKey: ['connector', id] });
      queryClient.invalidateQueries({ queryKey: ['connector-status', id] });
      queryClient.invalidateQueries({ queryKey: ['graph-stats'] });
    },
  });
}

export function useCreateConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateConnectorInput) => createConnector(input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['connectors'] });
    },
  });
}

export function usePatchConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; input: UpdateConnectorInput; ifMatch?: string }) =>
      patchConnector(vars.id, vars.input, vars.ifMatch),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['connectors'] });
      queryClient.invalidateQueries({ queryKey: ['connector', vars.id] });
    },
  });
}

export function useDeleteConnector() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; ifMatch?: string }) => deleteConnector(vars.id, vars.ifMatch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['connectors'] });
    },
  });
}

export function useProbeConnector() {
  // Probe never mutates server state; use the mutation hook for the
  // "fire on click" semantics, not because it's a write.
  return useMutation({
    mutationFn: probeConnector,
  });
}

// Global GitHub App state. Wizard reads this on open to decide whether
// to ask the user to configure a shared App (first connector) or offer
// the existing one (subsequent connectors).
export function useGitHubAppStatus() {
  return useQuery<GitHubAppStatusWithHash>({
    queryKey: ['github-app-status'],
    queryFn: fetchGitHubAppStatus,
    // No polling — the value only changes when a wizard PUT's it, and we
    // invalidate explicitly in that mutation's onSuccess.
    staleTime: Infinity,
  });
}

// Wizard's manifest flow uses this to mint a CSRF token, then redirects
// the user to GitHub. Mutation hook for the "fire on click" semantics.
export function useFetchManifestState() {
  return useMutation({ mutationFn: fetchManifestState });
}

export function useUpdateGitHubApp() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { id: string; privateKeyPath: string; ifMatch?: string }) =>
      updateGitHubApp({ id: vars.id, privateKeyPath: vars.privateKeyPath }, vars.ifMatch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['github-app-status'] });
    },
  });
}
