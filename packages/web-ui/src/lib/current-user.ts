/**
 * Mock current-user record. The app doesn't have an auth layer wired up yet,
 * so every view that needs "who am I" reads this singleton. When auth lands,
 * this file becomes the seam — replace the export with `useCurrentUser()` or
 * a server-component fetch and every consumer keeps working.
 *
 * Values come from `NEXT_PUBLIC_DEV_USER_*` env vars when set (override per
 * developer via `.env.local`), with neutral fallbacks for fresh checkouts.
 * `NEXT_PUBLIC_*` is required because these reads happen in client
 * components — those vars get inlined at build time.
 *
 * See `.env.example` for the full key list.
 */

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

function envOr(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.length > 0 ? v : fallback;
}

const DEFAULT_CAPABILITIES: ReadonlyArray<string> = [
  'admin',
  'graph:write',
  'connectors:manage',
  'schema:edit',
  'mcp:invoke',
];

function envCapabilities(): ReadonlyArray<string> {
  const raw = process.env['NEXT_PUBLIC_DEV_USER_CAPABILITIES'];
  if (!raw) return DEFAULT_CAPABILITIES;
  const parsed = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : DEFAULT_CAPABILITIES;
}

const firstName = envOr('NEXT_PUBLIC_DEV_USER_FIRST_NAME', 'Dev');
const lastName = envOr('NEXT_PUBLIC_DEV_USER_LAST_NAME', 'User');

export const CURRENT_USER: CurrentUser = {
  firstName,
  lastName,
  // Joined here so consumers don't have to. Trim handles the unlikely case
  // where someone sets only one of the two halves.
  name: `${firstName} ${lastName}`.trim(),
  email: envOr('NEXT_PUBLIC_DEV_USER_EMAIL', 'dev@shipit.local'),
  role: envOr('NEXT_PUBLIC_DEV_USER_ROLE', 'Platform Admin'),
  team: envOr('NEXT_PUBLIC_DEV_USER_TEAM', 'platform-team'),
  joinedAt: envOr('NEXT_PUBLIC_DEV_USER_JOINED_AT', '2026-01-01'),
  capabilities: envCapabilities(),
};
