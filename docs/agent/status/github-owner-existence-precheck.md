---
type: status
status: active
created: 2026-06-14
updated: 2026-06-14
author: claude-session-2026-06-14
branch: more-prod-fixes
agent: claude-session-2026-06-14
tags: [github, connectors, wizard, manifest, ux]
---

# Pre-launch GitHub org existence check in the Add-Connector wizard

## Scope

- `packages/api-server/src/routes/connectors.ts` — new
  `GET /api/connectors/github/owner-check?owner=<login>` endpoint
  (unauthenticated `api.github.com/users/{login}` proxy).
- `packages/web-ui/src/lib/api.ts` — `checkGitHubOwner` client fn.
- `packages/web-ui/src/components/connectors/add-github-connector-wizard.tsx`
  — gate `handleCreateInstanceApp` (per-org) and `handleCreateFromTemplate`
  (shared) on the check before `window.open`.

## Why

Typing a non-existent org login opened
`github.com/organizations/<typo>/settings/apps/new`, which GitHub
silently redirects to the user's PERSONAL `/settings/apps/new` instead of
404ing. Users unknowingly create the App on their personal account. The
launch endpoint's "validate softly, GitHub will 404" assumption
(connectors.ts ~L369) is wrong for the org-scoped URL.

User decision (2026-06-14): block only when the login does NOT exist;
allow personal accounts through. If the existence check itself can't run
(GitHub unreachable / rate-limited), do NOT block — fall through.

## Status

Implemented + verified locally. api-server typecheck + web-ui typecheck
clean; web-ui lint 0 errors; connectors test suite 271 passing (5 new
owner-check tests stub global `fetch`). Endpoint returns
`{owner, exists: true|false|null, type, htmlUrl}`; wizard's
`ensureOwnerExists` gates both `handleCreateInstanceApp` (per-org) and
`handleCreateFromTemplate` (shared) before `window.open`, shows an inline
`text-err` message, and disables the button with a "Checking org…"
spinner while in flight.

Blocked on: user approval to commit (and decide PR vs push). Not yet
committed — branch `more-prod-fixes`.
