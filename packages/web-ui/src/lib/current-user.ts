/**
 * Mock current-user record. The app doesn't have an auth layer wired up yet,
 * so every view that needs "who am I" reads this singleton. When auth lands,
 * this file becomes the seam — replace the export with `useCurrentUser()` or
 * a server-component fetch and every consumer keeps working.
 *
 * Values come from `frontend.devUser` in shipit.config.local.yaml. If the
 * block is absent we fall back to neutral placeholders so fresh checkouts
 * still render.
 */

import { clientConfig } from './client-config';

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

const cfg = clientConfig.devUser;

const firstName = cfg?.firstName ?? 'Dev';
const lastName = cfg?.lastName ?? 'User';

export const CURRENT_USER: CurrentUser = {
  firstName,
  lastName,
  // Joined here so consumers don't have to. Trim handles the unlikely case
  // where someone sets only one of the two halves.
  name: `${firstName} ${lastName}`.trim(),
  email: cfg?.email ?? 'dev@shipit.local',
  role: cfg?.role ?? 'Platform Admin',
  team: cfg?.team ?? 'platform-team',
  joinedAt: cfg?.joinedAt ?? '2026-01-01',
  capabilities: cfg?.capabilities ?? DEFAULT_CAPABILITIES,
};
