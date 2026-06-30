---
type: status
status: completed
created: 2026-06-18
updated: 2026-06-18
author: claude-session-2026-06-18-portal-settings
branch: next-release
agent: claude-session-2026-06-18-portal-settings
tags: [admin, settings, webhooks, oauth, allow-list, secrets, web-ui, api-server]
---

# Admin Portal Settings hub — implemented, uncommitted

Executes [admin-portal-settings](../plans/admin-portal-settings.md) (full scope —
the allow-list infra grant is now in place, so the allow-list WRITE shipped too,
not read-only). NOT yet committed (standing rule: never commit/push without
explicit approval).

## Scope landed (uncommitted, branch next-release)

- **api-server**: `services/settings-service.ts` (central secret-write/last-verified
  service); `routes/portal-settings.ts` (admin-gated `/api/settings`: GET snapshot,
  webhook setup/rotate, PUT oauth/admins/allowlist); `setup-service.ts` +CSV-aware
  `setAdminEmails`; `connector-app-store.ts` +`setWebhookSecret` (runtime sidecar +
  blob); `webhook-refetch-queue.ts` + receiver `recordVerifiedDelivery`/
  `getLastVerifiedDelivery`; `secrets/types.ts` `auth-allow-list-emails` → WRITABLE;
  server.ts/index.ts wiring + decoration.
- **web-ui**: `components/settings/webhooks-tab.tsx` (per-connector status + secret
  reveal dialog with steps/copy) + `access-tab.tsx` (OAuth/admins/allow-list with
  confirm dialogs); `lib/api.ts` settings fns; `(app)/settings/page.tsx` admin tabs;
  sidebar admin-only Settings entry + gating.

## Review fix applied (post-agent)

The backend agent added a self-lockout guardrail on `PUT /allowlist` — WRONG:
admins bypass the allow-list (routes/auth.ts), so it's false protection + blocks
valid curation. Removed it (kept on `/admins`), added the missing
`InvalidAllowlistEmailError`→400 mapping, and corrected the test.

## Verified

`pnpm -r typecheck` clean. Tests green: api-server 373 (portal-settings 17),
web-ui 98 (+7), all other packages unchanged-green. web-ui lint 0 errors;
prettier clean.

## Security posture (enforced + tested)

Admin 403 on every endpoint (server-side; UI hide cosmetic + fails closed);
self-lockout 422 on `/admins`; allow-list empty-confirm in UI; webhook secret
returned to admin only, never logged; per-org vs global secret routing (no
downgrade).

## Operational note

The allow-list write path is built + unit-tested (store mocked); its REAL runtime
success on-cluster depends on the GSM IAM grant actually being live — verify with
a real save post-deploy.

## Blocked on

User approval to commit / push.
