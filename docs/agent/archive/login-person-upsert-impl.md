---
type: status
status: completed
created: 2026-06-14
updated: 2026-06-14
author: claude-session-2026-06-14-login-person
branch: more-prod-fixes
agent: claude-session-2026-06-14-login-person
tags: [auth, graph, person, event-bus, core-writer]
---

# Implementing login-user-as-Person upsert

> **SHIPPED & DEPLOYED** (#67, 2026-06). Archived.

## Scope

Executing [login-user-as-person-entity](../plans/login-user-as-person-entity.md).
Touching:

- `packages/api-server/src/server.ts` — `CreateServerOptions.eventBus` + decorate.
- `packages/api-server/src/index.ts` — hoist `BullMQEventBusClient` out of the
  redis-gated scheduler block; pass into `createServer`.
- `packages/api-server/src/services/person-upsert.ts` — NEW pure builder.
- `packages/api-server/src/routes/auth.ts` — best-effort upsert after session set;
  surface `login` out of `resolvePrincipal`.
- `packages/core-writer/src/claims/strategies.ts` +
  `packages/api-server/src/services/claim-service.ts` — add `'login'` to source order.

## User decisions (2026-06-14, this session)

1. **OIDC: include best-effort** — OIDC logins upsert a Person keyed by email
   (`shipit://person/default/<email>`); won't merge with GitHub-connector Persons
   (documented limitation). GitHub logins key by `login.toLowerCase()` (merges).
2. **No avatar** — do NOT capture `avatar_url` and do NOT extend `AuthPrincipal`.
   Person carries `name`/`email`/`login` claims only; the connector supplies the
   avatar. (Drops the planned `github-provider.ts` + shared-type changes.)
3. `login` source confidence = 0.85 (< connector 0.9). Add `'login'` to both
   source-priority lists for consistency (non-blocking — default is HIGHEST_CONFIDENCE).

## Why

Logged-in users are real Person entities but never reach the graph today; a login
only sets a session principal. See plan for the full root cause.

## Status

Implemented + verified locally. typecheck green; api-server tests 290 passing
(+9: 6 person-upsert builder unit tests, 3 auth-route Person-upsert tests —
github login-keyed, oidc email-keyed, publish-failure resilience); core-writer
tests green; Prettier clean on all touched files. NOT yet committed.

Files landed:

- `server.ts` — `CreateServerOptions.eventBus` + conditional decorate + FastifyInstance aug.
- `index.ts` — hoisted `eventBus` (named var), passed to `createServer`, `eventBus.close()` on shutdown.
- `services/person-upsert.ts` — NEW pure `buildLoginPersonEntity(identity, now?)`.
- `routes/auth.ts` — `loginIdentity` out of `resolvePrincipal`; best-effort `upsertLoginPerson` after session set.
- `core-writer/src/claims/strategies.ts` + `api-server/src/services/claim-service.ts` — `'login'` below `'github'`.

## Blocked on

User approval to commit (memory: never commit/push without explicit approval).
NOTE: works on-cluster only where Redis is reachable (event bus). No new infra/GSM
secret needed — rides the existing BullMQ + core-writer path.
