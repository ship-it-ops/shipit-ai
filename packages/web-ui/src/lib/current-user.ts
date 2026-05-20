/**
 * Mock current-user record. The app doesn't have an auth layer wired up yet,
 * so every view that needs "who am I" reads through `useCurrentUser()`. When
 * auth lands, this hook becomes the seam — every consumer keeps working.
 *
 * Base values come from `frontend.devUser` in shipit.config.local.yaml (baked
 * into the bundle by next.config.mjs at dev-server start). On the client, we
 * overlay any value the user saved through the onboarding modal — that value
 * lives in localStorage so the UI updates without a dev-server restart.
 */

'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { clientConfig, type DevUserConfig } from './client-config';

export interface CurrentUser {
  firstName: string;
  lastName: string;
  /** Convenience for views that show the full name (Avatar initials, profile heading). */
  name: string;
  email: string;
  role: string;
  team: string;
  joinedAt: string;
  /** Coarse capability strings, mirrors what RBAC will eventually grant. */
  capabilities: ReadonlyArray<string>;
}

const DEFAULT_CAPABILITIES: ReadonlyArray<string> = [
  'admin',
  'graph:write',
  'connectors:manage',
  'schema:edit',
  'mcp:invoke',
];

export const DEV_USER_OVERRIDE_KEY = 'shipit:dev-user-override';
export const ONBOARDING_COMPLETE_KEY = 'shipit:onboarding-complete';
export const DEV_USER_CHANGED_EVENT = 'shipit:dev-user-changed';

function buildUser(cfg: DevUserConfig | null): CurrentUser {
  const firstName = cfg?.firstName ?? 'Dev';
  const lastName = cfg?.lastName ?? 'User';
  return {
    firstName,
    lastName,
    name: `${firstName} ${lastName}`.trim(),
    email: cfg?.email ?? 'dev@shipit.local',
    role: cfg?.role ?? 'Platform Admin',
    team: cfg?.team ?? 'platform-team',
    joinedAt: cfg?.joinedAt ?? '2026-01-01',
    capabilities: cfg?.capabilities ?? DEFAULT_CAPABILITIES,
  };
}

const buildTimeUser: CurrentUser = buildUser(clientConfig.devUser);

function readOverride(): DevUserConfig | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(DEV_USER_OVERRIDE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<DevUserConfig>;
    if (
      typeof parsed.firstName === 'string' &&
      typeof parsed.lastName === 'string' &&
      typeof parsed.email === 'string' &&
      typeof parsed.role === 'string' &&
      typeof parsed.team === 'string' &&
      typeof parsed.joinedAt === 'string' &&
      Array.isArray(parsed.capabilities)
    ) {
      return parsed as DevUserConfig;
    }
  } catch {
    // Stale override — fall through to the build-time value.
  }
  return null;
}

// useSyncExternalStore guards against tearing if useCurrentUser fires from
// multiple components during the same render. The snapshot is cached per
// listener so React's equality check short-circuits when nothing changed.
let cachedOverrideRaw: string | null | undefined = undefined;
let cachedUser: CurrentUser = buildTimeUser;

function getSnapshot(): CurrentUser {
  if (typeof window === 'undefined') return buildTimeUser;
  const raw = window.localStorage.getItem(DEV_USER_OVERRIDE_KEY);
  if (raw === cachedOverrideRaw) return cachedUser;
  cachedOverrideRaw = raw;
  cachedUser = buildUser(readOverride() ?? clientConfig.devUser);
  return cachedUser;
}

function getServerSnapshot(): CurrentUser {
  return buildTimeUser;
}

function subscribe(notify: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const handler = () => notify();
  // Same-tab updates go through a custom event; cross-tab updates come from
  // the native `storage` event. Both call notify; useSyncExternalStore
  // dedupes via the snapshot identity check.
  window.addEventListener(DEV_USER_CHANGED_EVENT, handler);
  window.addEventListener('storage', handler);
  return () => {
    window.removeEventListener(DEV_USER_CHANGED_EVENT, handler);
    window.removeEventListener('storage', handler);
  };
}

export function useCurrentUser(): CurrentUser {
  const user = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  // Re-derive after hydration in case localStorage diverges from the SSR
  // snapshot — without this, the first client render shows the build-time
  // values briefly before useSyncExternalStore notices the storage on the
  // next event.
  useEffect(() => {
    cachedOverrideRaw = undefined;
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new Event(DEV_USER_CHANGED_EVENT));
    }
  }, []);
  return user;
}

/** Push a saved devUser into localStorage and broadcast the change. */
export function persistDevUserOverride(value: DevUserConfig): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(DEV_USER_OVERRIDE_KEY, JSON.stringify(value));
  window.localStorage.setItem(ONBOARDING_COMPLETE_KEY, 'true');
  window.dispatchEvent(new Event(DEV_USER_CHANGED_EVENT));
}

/** Mark onboarding complete without touching the override (e.g., manual-paste dismiss). */
export function markOnboardingComplete(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(ONBOARDING_COMPLETE_KEY, 'true');
  window.dispatchEvent(new Event(DEV_USER_CHANGED_EVENT));
}
