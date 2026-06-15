// Cross-tab resume record for the per-org GitHub App manifest flow.
//
// The per-org "Create App on GitHub" flow opens a new tab, the user
// creates the App on github.com, and the server stashes the new App's
// credentials keyed by a `nonce`. Originally the nonce lived ONLY in the
// launching tab's React state, so if the user came back via the callback
// page's "Return to ShipIt-AI →" link (a fresh page load) the wizard
// reopened empty and the credentials were never claimed (they expired in
// the server's 15-minute pending map).
//
// Persisting the nonce + the in-progress wizard fields to localStorage
// lets ANY same-origin tab (the original wizard OR the fresh returning
// one) restore the user's input and claim the credentials. Because the
// claim is single-use server-side, the tab that wins writes `claimed`
// back into this record so a sibling tab that lost the race can still
// pick up the credentials instead of polling forever.
import type { ConnectorScope, ConnectorEntities } from '@/lib/api';

const STORAGE_KEY = 'shipit:pending-github-app';

// Records older than this are ignored + cleared: the server's
// pending-instance TTL is 15 minutes, so a half-hour-old record can never
// be claimed and would only get the wizard stuck on "Waiting for GitHub…".
const STALE_MS = 30 * 60 * 1000;

export interface PendingGitHubApp {
  nonce: string;
  // Only the per-org path uses this record (shared/global has its own
  // app-status polling), but we keep the field explicit for clarity.
  mode: 'per-org';
  manifestOwner: string;
  connectorId: string;
  name: string;
  org: string;
  scope: ConnectorScope;
  entities: ConnectorEntities;
  createdAt: number;
  // Filled by whichever tab successfully claims the credentials, so a
  // sibling tab that got a 404 (single-use already consumed) can recover.
  claimed?: { appId: string; appName: string; privateKeyPath: string };
}

function canUseStorage(): boolean {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

export function readPendingGitHubApp(): PendingGitHubApp | null {
  if (!canUseStorage()) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PendingGitHubApp;
    if (!parsed?.nonce) return null;
    if (typeof parsed.createdAt !== 'number' || Date.now() - parsed.createdAt > STALE_MS) {
      clearPendingGitHubApp();
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function writePendingGitHubApp(record: Omit<PendingGitHubApp, 'createdAt'>): void {
  if (!canUseStorage()) return;
  try {
    const payload: PendingGitHubApp = { ...record, createdAt: Date.now() };
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // Storage full / disabled — the in-tab polling path still works; this
    // only degrades the cross-tab return recovery.
  }
}

// Merge the claimed credentials into the existing record (if any) so a
// sibling tab can recover them. No-op when there's no record to update.
export function markPendingGitHubAppClaimed(claimed: PendingGitHubApp['claimed']): void {
  if (!canUseStorage()) return;
  const existing = readPendingGitHubApp();
  if (!existing) return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...existing, claimed }));
  } catch {
    // best-effort
  }
}

export function clearPendingGitHubApp(): void {
  if (!canUseStorage()) return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // best-effort
  }
}
