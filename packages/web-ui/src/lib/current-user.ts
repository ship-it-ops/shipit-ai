'use client';

// `useCurrentUser` is the single seam the rest of the web-UI reads identity
// through. Stage C1 of the auth milestone (auth-and-rbac branch) replaced
// the previous build-time + localStorage mock with a React-Query-backed
// fetch of `/api/auth/me`.
//
// Behavior summary:
//   - When accessControl.auth.enabled is FALSE, the api-server's
//     require-auth preHandler synthesizes a dev-fallback principal from
//     frontend.devUser in shipit.config.local.yaml; `/api/auth/me` always
//     returns 200. `useCurrentUser` resolves immediately to that principal.
//   - When auth.enabled is TRUE and the user has a valid session cookie,
//     `/api/auth/me` returns the real principal.
//   - When auth.enabled is TRUE and there's no session, `/api/auth/me`
//     returns 401. `lib/api.ts` dispatches `shipit:auth-required`; the
//     layout listens for it and routes to `/login`. The hook surfaces the
//     401 state so individual consumers can render a placeholder if they
//     want, but they don't have to handle redirection themselves.
//
// `team` and `joinedAt` are kept on the `CurrentUser` shape so existing
// consumers (the profile page) don't churn — they're populated only when
// the API surfaces them (the dev-fallback principal does, since the
// server can read them from frontend.devUser in shipit.config). Real
// OIDC providers don't typically return either; the profile page treats
// the empty case gracefully.

import { useQuery } from '@tanstack/react-query';
import { clientConfig } from './client-config';

const API_URL = clientConfig.api.url;

export interface CurrentUser {
  id: string;
  firstName: string;
  lastName: string;
  /** Convenience for views that show the full name (Avatar initials, profile heading). */
  name: string;
  email: string;
  role: string;
  team: string;
  joinedAt: string;
  /** Coarse capability strings — wildcard `*` means "all capabilities". */
  capabilities: ReadonlyArray<string>;
  /** Which provider issued the current session (oidc, github, dev-fallback, mcp-token). */
  provider: string;
}

// These constants are still consumed by the onboarding wizard and trigger
// (Stage C4 retires them along with the wizard rewrite). Keeping them
// exported avoids churn in the same commit; the wizard's localStorage
// writes are observed by the trigger to suppress the "first run" prompt.
export const DEV_USER_OVERRIDE_KEY = 'shipit:dev-user-override';
export const ONBOARDING_COMPLETE_KEY = 'shipit:onboarding-complete';
export const DEV_USER_CHANGED_EVENT = 'shipit:dev-user-changed';

interface MeResponse {
  user: {
    id: string;
    email: string;
    displayName: string;
    provider: string;
    role: string;
    capabilities: string[];
    // Surfaced by the api-server when the principal originates from the
    // frontend.devUser config block. Real OIDC providers won't typically
    // ship these.
    team?: string;
    joinedAt?: string;
  };
  org: string;
}

// Fallback used while the /api/auth/me query is in flight on the first
// render. Keeps the Avatar / profile header from popping in with empty
// values; reflects what dev-fallback mode would produce on a fresh repo
// with no devUser configured.
const PLACEHOLDER_USER: CurrentUser = {
  id: 'pending',
  firstName: '',
  lastName: '',
  name: '',
  email: '',
  role: '',
  team: '',
  joinedAt: '',
  capabilities: [],
  provider: 'pending',
};

function splitDisplayName(displayName: string): { firstName: string; lastName: string } {
  const parts = displayName.trim().split(/\s+/);
  if (parts.length === 0 || parts[0] === '') {
    return { firstName: '', lastName: '' };
  }
  if (parts.length === 1) {
    return { firstName: parts[0]!, lastName: '' };
  }
  return {
    firstName: parts[0]!,
    lastName: parts.slice(1).join(' '),
  };
}

function meResponseToUser(me: MeResponse): CurrentUser {
  const { firstName, lastName } = splitDisplayName(me.user.displayName);
  return {
    id: me.user.id,
    firstName,
    lastName,
    name: me.user.displayName,
    email: me.user.email,
    role: me.user.role,
    team: me.user.team ?? '',
    joinedAt: me.user.joinedAt ?? '',
    capabilities: me.user.capabilities,
    provider: me.user.provider,
  };
}

async function fetchMe(): Promise<MeResponse> {
  const res = await fetch(`${API_URL}/api/auth/me`, { credentials: 'include' });
  if (!res.ok) {
    // The 401 case is the auth-enabled / no-session path. The shared
    // fetchApi wrapper in lib/api.ts already dispatches the
    // shipit:auth-required event for the rest of the app; we throw so
    // React Query surfaces the failure to consumers (and useCurrentUser
    // returns the placeholder instead of stale data).
    if (res.status === 401 && typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('shipit:auth-required'));
    }
    throw new Error(`auth/me ${res.status}`);
  }
  return (await res.json()) as MeResponse;
}

/**
 * Read the current authenticated user. Returns a placeholder shape while
 * the query is in flight or after an auth failure; consumers that need
 * to distinguish loading from "really signed out" should use the
 * `isLoading` / `isError` flags returned by `useCurrentUserQuery` instead.
 */
export function useCurrentUser(): CurrentUser {
  const { data } = useCurrentUserQuery();
  return data ?? PLACEHOLDER_USER;
}

/** Same source as `useCurrentUser` but returns the full React Query
 *  state so callers can branch on `isLoading` / `isError`. */
export function useCurrentUserQuery() {
  return useQuery({
    queryKey: ['auth', 'me'],
    queryFn: fetchMe,
    select: meResponseToUser,
    staleTime: 5 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  });
}

// --- Legacy onboarding helpers ---------------------------------------------
// The wizard still calls these to mark its localStorage flag and persist
// the operator's preferred dev identity. `useCurrentUser` no longer reads
// either — the source of truth for the dev-fallback principal is
// frontend.devUser in shipit.config.local.yaml, which the api-server's
// require-auth preHandler synthesizes server-side. Stage C4 of the auth
// milestone retires the wizard's identity-editing surface and removes
// these helpers along with it.

interface LegacyDevUserPayload {
  firstName: string;
  lastName: string;
  email: string;
  role: string;
  team: string;
  joinedAt: string;
  capabilities: ReadonlyArray<string>;
}

export function persistDevUserOverride(value: LegacyDevUserPayload): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(DEV_USER_OVERRIDE_KEY, JSON.stringify(value));
  window.localStorage.setItem(ONBOARDING_COMPLETE_KEY, 'true');
  window.dispatchEvent(new Event(DEV_USER_CHANGED_EVENT));
}

export function markOnboardingComplete(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ONBOARDING_COMPLETE_KEY, 'true');
  window.dispatchEvent(new Event(DEV_USER_CHANGED_EVENT));
}
