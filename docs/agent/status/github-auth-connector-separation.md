---
type: status
status: active
created: 2026-06-14
updated: 2026-06-14
author: claude-session-2026-06-14
branch: more-prod-fixes
agent: claude-session-2026-06-14
tags: [auth, oauth, github, connectors, setup, wizard]
---

# Per-org claim resume + auth/connector App separation

## Scope

Two changes on branch `more-prod-fixes` (NOT yet committed):

1. **Bug 1 — per-org manifest claim survives a fresh page load.** New
   `packages/web-ui/src/lib/pending-github-app.ts` persists the nonce +
   in-progress wizard fields to localStorage; the wizard restores them on
   open and the existing poll claims the creds (with a cross-tab
   single-use race handoff via a `claimed` field). Fixes "Return to
   ShipIt-AI" landing on an empty wizard. No server change needed (localStorage
   carries the nonce — did NOT add a URL param).

2. **Auth = classic OAuth App; manifest connector-only.** See
   [auth-oauth-app-separate-from-connector](../decisions/auth-oauth-app-separate-from-connector.md).
   - `github-app-manifest-service.ts`: `buildManifest` drops `callback_urls`;
     `persistToGsm`/`exchangeAndPersist` no longer touch the OAuth client.
   - `config/github-app-manifest.json`: dropped `callback_urls`.
   - `routes/connectors.ts`: `manifestUrlsFromRequest` no longer returns callbackUrl.
   - `routes/setup.ts` + `setup-service.ts`: new `POST /api/setup/oauth`
     (`setOAuthClient`) writes the OAuth client id/secret.
   - `web-ui/src/app/(auth)/setup/page.tsx` + `lib/setup.ts`: GitHubAppStep is
     now an OAuth-App client id/secret form (`postSetupOAuth`).
   - `services/auth/github-provider.ts`: header comment corrected/expanded.

## Status

Implemented + verified locally: api-server tests 273 passing (updated 2
manifest/connector tests, added 3 setup-oauth tests); web-ui + api-server
typecheck clean; web-ui lint 0 errors. Tests updated:
`__tests__/routes/connectors.test.ts` (callback_urls now absent),
`__tests__/services/github-app-manifest-service.test.ts` (connector-only GSM
writes), `__tests__/routes/setup.test.ts` (oauth endpoint + active-mode 409).

## Operational (portal-demo, project ship-it-ai-portal)

- Login → new classic OAuth App: user updated `shipit-github-oauth-client-id/secret`
  in GSM; restart applied on next deploy. Callback URL must be
  `https://portal-demo.shipitops.com/api/auth/callback/github`.
- Connector secrets cleanup (optional, cosmetic-only after this deploys):
  overwrite `shipit-github-app-id` / `-private-key` / `-webhook-secret` with an
  EMPTY version (NEVER disable/destroy — FAILED_PRECONDITION on `latest` crashes
  boot; store only treats NOT_FOUND as empty). Then rollout restart.

## Follow-on (same branch, NOT yet committed): durable per-org connectors

Implemented [connector-apps-gsm-blob-durability](../decisions/connector-apps-gsm-blob-durability.md):
new `connector-apps` GSM blob + `ConnectorAppStore` (`services/connector-app-store.ts`),
registry `durableStore` hook in `persistInner()`, boot rehydrate+merge in `index.ts`,
secret taxonomy entry. api-server tests 281 passing (+8: connector-app-store, registry
durable hook, types). Needs the infra brief
[infra-connector-apps-secret](../briefs/infra-connector-apps-secret.md) (new GSM container

- api-server write/read IAM) before it works on-cluster; app-side ships safely first.

## Blocked on

User approval to commit (memory: never commit/push without explicit approval).
