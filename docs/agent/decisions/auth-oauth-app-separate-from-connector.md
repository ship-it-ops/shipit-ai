---
type: decision
status: active
created: 2026-06-14
updated: 2026-06-14
author: claude-session-2026-06-14
tags: [auth, oauth, github, connectors, setup, gsm]
importance: core
---

# Login uses a classic OAuth App; the manifest flow is connector-only

## Context

First-boot setup minted ONE GitHub App via the manifest flow (`target=global`)
and `persistToGsm` split its credentials into BOTH the login OAuth secrets
(`github-oauth-client-id/secret`) and the connector slot
(`github-app-id`/`github-app-private-key`/`github-webhook-secret`). That single
App (portal-demo: 4034808) therefore did double duty: "Sign in with GitHub" AND
the connector Hub's shared App.

Two problems surfaced on portal-demo (2026-06-14):

- The connector wizard showed a "shared GitHub App" the operator never knowingly
  configured — it was the setup/login App.
- Latent bug: creating a connector "shared" App (`target=global`) would call
  `persistToGsm` and **overwrite the login OAuth client**, breaking login.
- The login runtime (`services/auth/github-provider.ts`) was already written for a
  classic OAuth App (sends `user:email`/`read:org` scopes, reads `/user/emails`).
  But a GitHub App user token can't read `/user/emails` without the
  `email_addresses` account permission (absent from the manifest), so the login
  allow-list/admin match silently fell back to PUBLIC email only.

User decision (2026-06-14): **separate auth from the connector**, provisioning
login as a **classic GitHub OAuth App** (not a GitHub App). The OAuth App's native
`user:email` scope closes the email gap with no manifest permission change.

## Decision

- **Login = a classic OAuth App**, created by the operator by hand (GitHub has no
  one-click manifest flow for OAuth Apps). The first-run setup wizard's GitHub step
  is now a form: it shows the required Authorization callback URL
  (`<origin>/api/auth/callback/github`), links to GitHub's New OAuth App page, and
  collects Client ID + Client Secret. New endpoint `POST /api/setup/oauth`
  (`SetupService.setOAuthClient`) writes `github-oauth-client-id/secret` to GSM +
  process env, flipping the existing `oauthClientPresent` gate.
- **The GitHub App manifest flow is connector-only.** `buildManifest` no longer
  emits `callback_urls`; `exchangeAndPersist`/`persistToGsm` no longer read or write
  the OAuth client — only `github-app-id` + `github-app-private-key` +
  `github-webhook-secret`. This also removes the login-clobber bug.
- The `github-provider.ts` header comment ("standard OAuth App, not GitHub App") is
  now accurate and expanded.

## Consequences

- After a fresh setup the connector global slot is EMPTY → the connector wizard's
  shared card shows first-run "not configured"; the operator creates a dedicated
  connector App (shared or per-org). No mystery shared App.
- Setup now requires manual OAuth App creation (no one-click) — accepted tradeoff
  for clean separation.
- Existing demo migration (operational, mostly done by the user):
  update `shipit-github-oauth-client-id/secret` in GSM (project `ship-it-ai-portal`)
  to the new OAuth App, set its callback URL to
  `https://portal-demo.shipitops.com/api/auth/callback/github`, restart api-server.
  Optionally clear the connector secrets (`shipit-github-app-id`,
  `-private-key`, `-webhook-secret`) so the wizard shows not-configured —
  **overwrite with an EMPTY version, never disable/destroy**: the GSM store only
  treats NOT_FOUND (code 5) as empty; a disabled/destroyed `latest` returns
  FAILED_PRECONDITION and crashes boot hydration (`secrets/gsm-store.ts:54-73`).

## Revisit Triggers

- A hosted/SaaS tier wants one-click login provisioning → revisit (GitHub App user
  auth + the `email_addresses` permission would restore one-click at the cost of
  this separation).

## Related

- [github-app-manifest-flow](./github-app-manifest-flow.md) — the manifest flow this
  trims to connector-only (OAuth-cred persistence removed)
- [gsm-secret-store-and-config-export](./gsm-secret-store-and-config-export.md) — the
  secret taxonomy; oauth vs connector containers
- [setup-mode-first-boot](./setup-mode-first-boot.md) — the setup wizard the OAuth
  form now lives in
