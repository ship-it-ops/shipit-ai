---
type: decision
status: active
created: 2026-05-26
updated: 2026-05-26
author: claude-opus-4-7
tags: [security, dependabot, fastify, api-server]
importance: core
---

# Migrate api-server from Fastify v4 → v5 to close 6 Dependabot Fastify alerts

## Context

The prior `dependabot-resolution-strategy` decision (2026-05-24) deferred the Fastify v4→v5 migration and recommended dismissing 6 Dependabot alerts (#1, #2, #3, #12, #13, #24) as "v5-only, no v4 backport." That dismissal step was never executed. After PR #14 merged, those 6 Fastify alerts remained the only open Dependabot items on `main` (the hono alerts #16, #50 auto-closed against the existing `^4.12.18` override).

On `fix-vulns` (cut from current `main` at e67da0c), the user opted to actually migrate rather than dismiss, since:

- Fastify v4 is past its LTS window.
- Migration scope turned out to be much smaller than feared — audit found 0 `schema:` blocks in routes, 0 `request.protocol`/`trustProxy` use, 0 custom validators, 0 custom `setNotFoundHandler`, and tests already use `server.inject()` (so they exercise the full Fastify boot path).
- Three `@fastify/*` plugins (cors, rate-limit, swagger) needed major bumps anyway to be v5-compatible.

## Decision

In `packages/api-server/package.json`, bump:

- `fastify`: `^4.28.0` → `^5.8.5`
- `@fastify/cors`: `^9.0.0` → `^11.2.0`
- `@fastify/rate-limit`: `^9.1.0` → `^10.3.0`
- `@fastify/swagger`: `^8.15.0` → `^9.7.0`

No source changes were required:

- `enableDraftSpec` (server.ts:80) is unchanged in `@fastify/rate-limit` v10 (verified against installed types).
- `setErrorHandler(handler)` signature unchanged in v5.
- Three `addContentTypeParser` calls (server.ts:53,56,59) work without modification.
- Swagger OpenAPI 3 spec block (server.ts:82+) unchanged in v9.
- All 21 `request.body` usages typecheck clean under v5's stricter generics — no `as` casts needed.

## Alternatives Considered

- **Dismiss the 6 alerts and stay on v4** (the prior decision). Rejected because the migration cost (described as substantial in the prior decision) turned out to be trivial — no schema validation, no proxy-trust surfaces, no custom validators, and tests already use the production server factory. The only "real" risk would have been the three plugin majors, but those land cleanly. v4 also has no security backports for these GHSAs and is unlikely to receive any.
- **Bump only fastify (Dependabot PRs #20/#21) and leave `@fastify/*` plugins on v9/v9.1/v8.** Rejected — those plugin versions don't support Fastify v5 (peer-dep range mismatch). The Dependabot-prepared PRs were structurally incomplete and would not have built.

## Consequences

- All 6 Fastify Dependabot alerts close on next rescan (after `fix-vulns` merges to `main`).
- Dependabot PRs #20 and #21 become obsolete and can be closed with a pointer to this branch.
- Future work on api-server routes benefits from v5's better TypeScript ergonomics (`request.body` typed via route generics, not the v4 fallback).
- `@fastify/rate-limit` v10 changed _some_ internal-only types; if any code adds custom rate-limit hooks later, double-check the new typings.
- `@fastify/swagger` v9 dropped Swagger v2 spec support. We're on OpenAPI 3 already, so no impact today, but anyone adding Swagger UI integration should pick `@fastify/swagger-ui` v5+ to match.

## Revisit Triggers

- **A future Fastify v6 ships.** Most `@fastify/*` plugins will bump again in lockstep — same playbook as this migration.
- **A new `@fastify/swagger` major.** If we start using Swagger UI, the swagger-ui plugin needs to track this major.
- **CodeQL or a security scanner flags the trust-proxy surface.** We currently don't set `trustProxy` and don't read `request.protocol`/`request.host`. If a route starts reading either, see GHSA-444r-cwp2-x5xf for the v5 behavior change.

## Critical files touched

- `packages/api-server/package.json` — 4 dep bumps.
- `pnpm-lock.yaml` — regenerated.
- No source files modified.

## Verification

- `pnpm --filter @shipit-ai/api-server typecheck` → clean.
- `pnpm turbo typecheck` → 14/14 green.
- `pnpm turbo test --force` → 385 tests passing (105 api-server route tests via `server.inject()` exercise the v5 runtime, including `reply.type('text/html').send(...)` manifest paths, ETag concurrency, content-type parsing, CORS, rate-limit, error handler).
- Module-load sanity: `fastify`, `@fastify/cors`, `@fastify/rate-limit`, `@fastify/swagger` all import cleanly under Node 22.
- `pnpm --filter @shipit-ai/web-ui build` → succeeds (verified bundled Tailwind 4.3.0 stable upgrade in same branch).

## Related

- [dependabot-resolution-strategy](dependabot-resolution-strategy.md) — supersedes the "defer Fastify v4→v5" portion of that decision.
- [github-connector-architecture-v1](github-connector-architecture-v1.md)
