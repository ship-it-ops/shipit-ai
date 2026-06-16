---
type: plan
status: active
created: 2026-06-16
updated: 2026-06-16
author: claude-opus-4-8
tags: [pr-74, code-review, security, concurrency, rate-limit, core-writer]
importance: standard
---

# PR #74 review fixes (CodeQL + 3 should-fix + 1 nit)

## Goal

Get PR #74 green and address the ship-reviewed-prs bot findings.

## Approach (per finding)

### F1 — Rate limiting (REQUIRED, failing CodeQL) — `routes/claims.ts`

CodeQL `js/missing-rate-limiting` flags authorization handlers lacking a
route-local limiter. Global limiter exists; the repo pattern (auth.ts:174,
setup.ts:30) is per-route `{ config: { rateLimit: {...} } }`. Add it to every
claims handler: mutating (verify, review/resolve) `{ max: 30, timeWindow: '1m' }`,
reads (review-queue, /:entityId, conflicts) `{ max: 120, timeWindow: '1m' }`.

### F2 — Forgeable audit actor (SC1) — `routes/claims.ts`

`actorOf()` falls back to `?actor=` query param. Replace with the resolved
principal `request.ctx.user.email` (always set by require-auth; SYSTEM_CONTEXT
default for internal). Drop the `actor` querystring from route generics.

### F3 — Review-queue scan truncation (IN3) — `services/verification-service.ts`

`listReviewQueue` scans a fixed prefix of ALL `_claims`-bearing nodes
(`LIMIT max(limit*4,200)`) in arbitrary order, then filters client-side, so real
candidates can fall outside the window. Push the verified-and-contradicted
predicate into Cypher via `apoc.convert.fromJsonList` so the scan returns only
candidate nodes, `ORDER BY n.id` (deterministic) + `LIMIT $limit`. Keep the
app-side per-field extraction as the authoritative row builder (also keeps the
FakeNeo4j unit test working). Keep `WHERE n._claims IS NOT NULL` substring.

### F4 — Lost-update race on `_claims` (IN4) — `services/verification-service.ts` + `services/neo4j-service.ts`

`verify()`/`resolveReview()` do read→modify→write across two `runQuery` calls
with no concurrency guard. Add `Neo4jService.runInWriteTransaction(fn)` (via
`session.executeWrite`) and do, in ONE tx: lock+re-read the node
(`MATCH (n {id}) SET n._claims_rev = coalesce(n._claims_rev,0)+1 RETURN n._claims,...`
— the SET takes a write lock so concurrent verifies serialize and each re-reads
the latest committed claims), mutate in app, `SET n._claims`, and CREATE the
VerificationEvent — all in the same tx. `_claims_rev` is `_`-prefixed (hidden
from UI). Note residual: a connector sync whose read predates the verify can
still overwrite within its own (separate) read→write window — that needs the
core-writer write path to also lock+re-read; logged as follow-up, out of scope.

### F5 — reconcile on every duplicate-skip (IN7 nit) — `core-writer/src/writer.ts`

Restore dup-check-first ordering; on the skip path, touch by `node.id` directly
(no reconcile). In steady-state re-sync the canonical id == node.id (deterministic
GitHub canonical IDs → primary-key match), so the touch hits the right node
without the per-duplicate reconcile DB lookup. Linking-key-merged nodes (rare,
id differs) won't get a dup-path touch — acceptable; they still bump on real
content change / TTL expiry as before.

## Files to touch

- `packages/api-server/src/routes/claims.ts` — F1, F2
- `packages/api-server/src/services/verification-service.ts` — F3, F4
- `packages/api-server/src/services/neo4j-service.ts` — F4 (tx helper)
- `packages/core-writer/src/writer.ts` — F5
- tests: `verification-service.test.ts` (FakeNeo4j: handle tx helper + new query),
  `writer.test.ts` (dup-path touch still asserted)

## Status

Completed 2026-06-16. All five implemented; api-server + core-writer suites green
(373 tests), typecheck clean. Residuals noted: (a) F4 closes verify-vs-verify and
verify-vs-resolve lost updates and makes verify re-read the latest claims under a
lock, but a connector sync whose read predates the verify can still overwrite
within its own separate read→write window — fully closing it needs the core-writer
write path to lock+re-read too (follow-up). (b) F5 dup-path touch is by node.id, so
a linking-key-merged node (stored id ≠ node.id, rare) won't get a dup-path touch —
it still bumps on real content change. (c) F3 Cypher predicate is APOC-dependent and
can't be exercised by the FakeNeo4j unit test; the app-side extraction remains the
authoritative row builder and is tested.

## Related

- [last-synced-frozen-by-idempotency-dedup](../investigations/last-synced-frozen-by-idempotency-dedup.md)
