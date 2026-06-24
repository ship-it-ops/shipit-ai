---
type: status
status: completed
created: 2026-06-19
updated: 2026-06-19
author: claude-session-2026-06-19-cutb-exec
branch: next-release
agent: claude-session-2026-06-19-cutb-exec
tags: [core-writer, event-version, freshness, idempotency, webhooks, neo4j, uncommitted]
---

# Webhook Cut B — implemented (Option B + scheduled cleanup), UNCOMMITTED

Executes [webhook-cut-b-content-freshness](../plans/webhook-cut-b-content-freshness.md).
NOT committed (standing rule: never commit/push without explicit approval).

## Scope landed (uncommitted, branch next-release)

- **shared**: `utils/event-version.ts` — `deriveTimeVersion` (sentinel/null on empty),
  `deriveContentVersion` (`ch_` sha256), `deriveNodeContentHash` (dedup fingerprint),
  `isContentVersion`; exported from index. canonical.ts `_event_version` comment rewritten.
- **event-bus**: `producer.ts buildIdempotencyKey` → content fingerprint (Option B).
- **core-writer**: `idempotency.ts buildNodeIdempotencyKey` → content fingerprint (matches
  producer); `neo4j/queries.ts mergeNode` → **atomic in-Cypher compare-and-set** guard
  (returns `written`; rejects only strictly-older comparable versions) + `touchLastSynced`
  made monotonic (never moves `_last_synced` backward); `node-writer.ts writeNode` returns
  `{written}`; `writer.ts` counts a distinct `freshnessSkipped`, records the dedup key on
  both accept and reject, logs each skip + a batch summary on the subscribed path;
  `idempotency-checker.ts cleanupExpired()` + `main.ts` daily reaper.
- **connector-github**: fetchers project `updated_at`/`pushed_at` (repo) + `updated_at`
  (workflow) in list + single-entity; normalizers derive versions (repo/pipeline time +
  content-hash fallback; team + team-member person content hash). CODEOWNERS unchanged (edge-only).
- **api-server**: `person-upsert.ts` → content-hash version (deterministic, no `now`).

## Verified

`pnpm -r typecheck` clean. Tests green: shared 116, event-bus 22, core-writer 73
(incl. new freshness-guard suite: newer-writes / older-skips / equal-writes / intra-batch /
legacy-1 / incomparable), connector-github 46 (normalizer version-shape + fallback),
api-server 375 (person determinism + sensitivity). All other packages typecheck-clean.

## Key design decisions (from the 5-persona audit)

- Guard is an **atomic in-Cypher CAS**, not app-level read-then-write (fixes the TOCTOU
  race under concurrency/replicas/retry; also sidesteps the neo4j lossless-Integer typing
  bug — Cypher compares natively).
- **Option B**: dedup key = content fingerprint, decoupled from the ordering token, so an
  equal-timestamp content change (e.g. Pipeline run-status while `created_at` is fixed) is
  not suppressed. Guard rejects on **strict `>`** so equal-version-different-content writes.
- Criterion 3 (out-of-order skip) holds for **timestamped entities only**; hashless
  entities are last-writer-wins (documented, accepted).

## Cypher coverage — CLOSED (was audit test-strategist-010)

The actual `mergeNode`/`touchLastSynced` Cypher is now covered by a Neo4j-backed
integration test: `packages/core-writer/src/__tests__/freshness-guard.integration.test.ts`
(`pnpm --filter @shipit-ai/core-writer test:integration`). Env-gated on `NEO4J_TEST_URI`
(skips in the default unit run; stays Docker-free). Validated against a real Neo4j 5 — 7/7
pass, including the **lossless-Integer legacy-`1` round-trip** (the data-migrations-001/002
concern), strict-`>` reject, equal-version-different-content write, and monotonic touch.
A dedicated CI `integration` job (Neo4j service container, runs on every PR/push, gates
`claude-review`) was added to `.github/workflows/ci.yml`.

## ROLLOUT runbook (audit data-migrations-007)

Deploy **api-server/connectors BEFORE (or together with) core-writer** — or the guard would
see an old replica's `_event_version:1` as older-than-stored and skip it. Cleanest: deploy
all version-emitters first, then core-writer. One-time effect: the first post-deploy sync
re-writes every entity once (content-key shape change) — trivial at current scale.

## ROLLBACK runbook (audit production-05)

A pure code-revert is NOT clean: reverted normalizers re-emit `_event_version:1` whose
content-key may already be in `_IdempotencyLog`, re-suppressing writes. To roll back safely,
ALSO purge the affected `_IdempotencyLog` entries (the daily reaper won't catch unexpired
ones): `MATCH (i:_IdempotencyLog) DELETE i` (or scoped per connector) after reverting.

## Blocked on

User approval to commit / push. (Optional: final ship-reviewed-prs vet of the diff.)
