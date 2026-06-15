---
type: plan
status: active
created: 2026-06-14
updated: 2026-06-14
author: claude-session-2026-06-14
tags: [auth, graph, person, entities, event-bus, core-writer]
importance: core
---

# Upsert the logged-in user as a Person entity on login

## Goal

A user who signs into the prod instance does not appear in the catalog or graph — but
logged-in users are real `Person` entities and belong in the knowledge graph. Today `Person`
nodes are created ONLY by the GitHub connector (team members, CODEOWNERS); a login produces
only a session principal that is never written to Neo4j. This plan upserts the authenticated
user as a `Person` on login completion, keyed so it **merges with** (never duplicates) the
connector's Person.

## Root cause (confirmed by exploration)

- `packages/api-server/src/routes/auth.ts` sets `request.session.principal` (~L315) and never
  touches the graph. The `/me` endpoint just echoes the principal.
- `Person` nodes come only from the connector, keyed
  `buildCanonicalId('Person','default', login)` → `shipit://person/default/<login>`
  (`packages/connectors/github/src/normalizers/team.ts`; Person is **global**, login-keyed —
  see [[canonical-id-org-namespacing]]).
- The api-server can READ the graph but **cannot publish to the event bus**: `index.ts` builds
  a `BullMQEventBusClient` but passes it only to the `SyncScheduler` — it is not decorated on
  the Fastify server, so routes can't publish. Writes are owned by the separate **core-writer**
  process ([[core-writer-runs-as-its-own-process]]).

## Approach — Option A: publish a Person `CanonicalEntity` from the login callback

Reuse the production-proven write path (connector → event bus → core-writer → Neo4j). No new
write endpoints (the manual-edit write path is still unbuilt — [[manual-edit-write-path]]).

1. **Expose the event bus to routes.** Add `eventBus?: EventBusClient` to `CreateServerOptions`
   (`server.ts`), `server.decorate('eventBus', …)`, and pass the existing client from
   `index.ts`. (The api-server process already publishes through this client via the scheduler;
   this only exposes it to routes.)
2. **Capture the identity bits login currently discards.** Extend GitHub `fetchUser` +
   `GitHubUserInfo` to keep `avatar_url` (today only `id/login/name/email` are captured), and
   surface `login` (+ `avatarUrl`) from `resolvePrincipal()` to the callback. (Optionally add
   `githubLogin`/`avatarUrl` to `AuthPrincipal` so the UI can show an avatar — see open
   decisions.)
3. **Upsert hook** in `routes/auth.ts`, right after the session principal is set — **best
   effort** (wrap in try/catch; a bus failure must NEVER block or fail login). Build one
   `Person` `CanonicalNode` and `eventBus.publish([{ nodes:[person], edges:[] }], 'login')`:
   - **Canonical id (GitHub):** `buildCanonicalId('Person','default', login.toLowerCase())` —
     identical to the connector, so the core-writer reconciler merges them on primary key.
   - **Claims/properties:** `name` (displayName), `email`, `avatar_url` (if captured), `login`.
     `source: 'login'`, `confidence` **below** the connector's 0.9 (e.g. 0.85) so the connector
     wins overlapping fields (`login`, `avatar_url`) while login fills the gaps the connector
     lacks (`email`, `name`) — default resolution is HIGHEST_CONFIDENCE.
   - **Provenance:** `_source_system:'login'`, `_source_org:'login'`, `_source_id` = a stable
     linking key (e.g. `idp://github/<sub>`), `_event_version` = a coarse time bucket (e.g. the
     login date) so re-logins refresh occasionally without a write storm (the callback fires
     once per login, so volume is already low; the bucket just dedups the idempotency key).
   - **Edges:** none — the connector owns team-membership edges.
4. **core-writer consumes automatically** (generic pipeline): reconcile by canonical id →
   merge with the connector Person or create a new one → resolve claims by confidence → write
   Neo4j. `Person` has no `_` prefix, so it appears in catalog/overview/search immediately.

## Key decisions & gotchas

- **MUST key on GitHub login, not email.** An email-keyed Person
  (`shipit://person/default/<email>`) would get a different canonical id and **never merge**
  with the connector's login-keyed Person → duplicate nodes. This is the single most important
  constraint.
- **Multi-provider.** OIDC/Google logins carry no GitHub login (only `sub`+`email`+`name`).
  v1 targets **GitHub OAuth** (the prod case). For OIDC, best-effort key by email
  (`shipit://person/default/<email>`) — it won't merge with GitHub-connector Persons (documented
  limitation; fine for OIDC-only deployments). Flagged as an open decision.
- **avatar_url is never fetched today** — capture it in `fetchUser` to give the Person an avatar.
- **Best-effort publish** — login must succeed even if Redis/the bus is down (log + continue).
- **Source-priority inconsistency** (writer `SOURCE_PRIORITY` vs api read `DEFAULT_SOURCE_ORDER`,
  [[manual-edit-write-path]] Gap 2) is NOT blocking — default strategy is HIGHEST_CONFIDENCE, not
  AUTHORITATIVE_ORDER. Add `'login'` to both lists for consistency and note the broader cleanup.

## Files to touch

- `packages/api-server/src/server.ts` — `CreateServerOptions.eventBus` + `server.decorate`.
- `packages/api-server/src/index.ts` — pass the existing `eventBus` into `createServer`.
- `packages/api-server/src/routes/auth.ts` — the best-effort upsert hook after the session set;
  surface `login`/`avatarUrl` out of `resolvePrincipal`.
- `packages/api-server/src/services/auth/github-provider.ts` — capture `avatar_url` in
  `fetchUser` + `GitHubUserInfo`.
- New `packages/api-server/src/services/person-upsert.ts` — pure builder
  `(principal, identity) → CanonicalNode`, reusing `buildCanonicalId` / `buildLinkingKey` from
  `@shipit-ai/shared`; model it on the connector Person in `connectors/github/.../team.ts`.
- (Optional) `packages/shared/src/auth/request-context.ts` — add `githubLogin`/`avatarUrl` to
  `AuthPrincipal` if we want the avatar in the session/UI.

## Verification

- **Unit:** the person-upsert builder produces the login-keyed (lowercased) canonical id + the
  expected claim shape (`name`/`email`/`avatar_url`/`login`, source `login`, confidence < 0.9);
  OIDC path keys by email.
- **Integration (local stack: api-server + core-writer + Neo4j + Redis):** sign in via GitHub →
  assert a node `shipit://person/default/<login>` exists with `email`/`name` claims; run a GitHub
  connector sync that includes that same login → assert it **merges** (one node, multi-source
  claims), not duplicates; assert the Person shows in `/catalog` + entity search.
- **Resilience:** stub a publish failure → login still completes.
- `pnpm turbo typecheck && pnpm turbo test && pnpm turbo lint` green.

## Status

**Implemented** on branch `more-prod-fixes` (2026-06-14); typecheck + 290 api-server tests
(+9 new) + core-writer green; Prettier clean. NOT yet committed (awaiting user approval).
Once shipped, the reporter's **next login** upserts them (no backfill needed; an optional
one-time backfill is just "log in again"). Dev-mode (auth disabled) and `mcp-token`
principals are inherently skipped — they never reach the `/callback/:provider` handler.

What changed vs. the original approach (per user decisions below): **avatar dropped** — no
`github-provider.ts` change, no `AuthPrincipal` change. The Person carries `name`/`email`/
`login` claims only; the connector supplies the avatar. New
`services/person-upsert.ts` builder; `eventBus` exposed via `CreateServerOptions` + decorate
(hoisted out of the redis-gated block in `index.ts` and closed on shutdown); best-effort
`upsertLoginPerson` in `routes/auth.ts` after the session is set; `'login'` added to both
source-priority lists.

## Open decisions — RESOLVED (2026-06-14, by user)

1. **OIDC keying** → **include best-effort.** OIDC logins upsert a Person keyed by email
   (won't merge with GitHub-connector Persons — documented limitation). GitHub logins key
   by `login.toLowerCase()` (merges). ✅ implemented.
2. **Session principal / avatar** → **no avatar.** Did NOT extend `AuthPrincipal` and did NOT
   capture `avatar_url`. Threaded only `login` + identity bits to the upsert hook. ✅
3. **`login` source** → confidence **0.85**; added `'login'` just below `'github'` in BOTH
   `strategies.ts` `SOURCE_PRIORITY` and `claim-service.ts` `DEFAULT_SOURCE_ORDER`. The
   pre-existing `manual` disagreement between those lists remains a separate cleanup
   ([[manual-edit-write-path]] Gap 2). ✅

## Related

- [[canonical-id-org-namespacing]] — Person is global + login-keyed (the merge key)
- [[core-writer-runs-as-its-own-process]] — the write path this rides on
- [[manual-edit-write-path]] — open question; non-connector writes + source-priority Gap 2
- [[github-connector-architecture-v1]] — the connector that also produces Person nodes
