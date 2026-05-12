/**
 * Mock current-user record. The app doesn't have an auth layer wired up yet,
 * so every view that needs "who am I" reads this singleton. When auth lands,
 * this file becomes the seam — replace the export with `useCurrentUser()` or
 * a server-component fetch and every consumer keeps working.
 */

export interface CurrentUser {
  name: string;
  email: string;
  role: string;
  team: string;
  joinedAt: string;
  /** Coarse capability strings, mirrors what RBAC will eventually grant. */
  capabilities: ReadonlyArray<string>;
}

export const CURRENT_USER: CurrentUser = {
  name: 'Mohamed El-Malah',
  email: 'mohamed.elmalah1211@gmail.com',
  role: 'Platform Admin',
  team: 'platform-team',
  joinedAt: '2026-03-15',
  capabilities: ['admin', 'graph:write', 'connectors:manage', 'schema:edit', 'mcp:invoke'],
};

export function firstName(user: CurrentUser): string {
  return user.name.split(/\s+/)[0] ?? user.name;
}
