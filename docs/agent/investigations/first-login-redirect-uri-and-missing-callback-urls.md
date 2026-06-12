---
type: investigation
status: completed
created: 2026-06-12
updated: 2026-06-12
author: claude-session-2026-06-12
branch: fix-first-startup
tags: [setup-mode, auth, github-oauth, manifest, deploy]
importance: core
---

# First login fails: relative doubled redirect_uri + App born without callback_urls

## Symptom

On portal-demo.shipitops.com first-run setup, after creating the GitHub
App via the wizard and installing it, every sign-in attempt lands on
GitHub's "Be careful! The redirect_uri is not associated with this
application" page. Before that, the very first attempt errored with
"This GitHub App must be configured with a callback URL". Adding
callback URLs manually in the App settings did not fix the redirect_uri
error.

## Root causes (two independent bugs)

1. **Relative, doubled redirect_uri** — `server.ts` built
   `publicBaseUrl` from `config.frontend.api.url` verbatim. On-cluster
   that value is the path-only `/api` (single-origin Ingress), so the
   GitHubProvider sent `redirect_uri=/api/api/auth/callback/github` —
   relative AND double-prefixed. GitHub requires an absolute URL matching
   a registered callback; no amount of App-settings edits can fix a
   client-side-wrong redirect_uri. Same bug class as the web-ui
   `normalizeApiBaseUrl` fix (see status/web-ui-dockerfile-pnpm-fix).

2. **Manifest never set `callback_urls`** — the App-manifest flow set
   `redirect_url` (post-creation browser redirect) but not
   `callback_urls` (OAuth sign-in callbacks). GitHub distinguishes the
   two; an App created without callback_urls cannot do OAuth login at
   all, hence the "must be configured with a callback URL" error on the
   first sign-in attempt.

## Fix (this branch)

- New `resolvePublicBaseUrl(frontendApiUrl, allowedOrigins)` in
  `packages/api-server/src/services/auth/public-base-url.ts`: absolute
  URLs pass through (trailing slash + trailing `/api` segment stripped);
  path-only values fall back to `accessControl.web.allowedOrigins[0]`
  (guaranteed non-empty by the auth bootability gate); throws
  AuthConfigError if neither yields an origin. Wired into both provider
  constructions in `server.ts`.
- `buildManifest` now requires `callbackUrl` and emits
  `callback_urls: [<proto>://<host>/api/auth/callback/github]` derived
  from the request's forwarded headers in `manifestUrlsFromRequest`
  (both `/manifest` and `/manifest/launch` call sites). Reference
  template gained a `PLACEHOLDER_CALLBACK_URL` entry.
- Tests: `public-base-url.test.ts` (5 cases) + callback_urls assertion
  in connectors route test. 251 api-server tests green; typecheck +
  prettier clean.

## Operational notes for the existing demo deployment

- Config-only unblock without redeploy: set the deployed
  `frontend.api.url` to `https://portal-demo.shipitops.com` (absolute,
  no /api) in the infra ConfigMap and restart the api-server — old code
  then derives the correct redirect_uri. Only `server.ts` consumed this
  value server-side; web-ui uses its build-time SHIPIT_API_URL instead.
- The manually-added callback URL
  `https://portal-demo.shipitops.com/api/auth/callback/github` is the
  correct one; the `/login` and bare-origin entries are unnecessary.
- The "Webhooks will be skipped" banner is working as designed: the
  deployed instance had no public `webhookPublicUrl` configured. Set it
  (or `GITHUB_WEBHOOK_PUBLIC_URL`) to
  `https://portal-demo.shipitops.com/api/webhooks/github` and add the
  webhook in the App settings, or re-run the wizard.

## Related

- [setup-mode-first-boot](../decisions/setup-mode-first-boot.md)
- [github-app-manifest-flow](../decisions/github-app-manifest-flow.md)
- [web-ui-dockerfile-pnpm-fix](../status/web-ui-dockerfile-pnpm-fix.md) —
  earlier web-ui leg of the same `/api` base-URL bug class
