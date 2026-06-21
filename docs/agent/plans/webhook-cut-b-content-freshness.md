---
type: plan
status: completed
created: 2026-06-19
updated: 2026-06-19
author: claude-session-2026-06-19-cutb-plan
branch: next-release
tags: [core-writer, event-version, freshness, idempotency, webhooks, neo4j, data-integrity, p1]
importance: core
---

# Webhook Cut B — content-freshness `_event_version` + atomic core-writer freshness guard

> Audited (5-persona standard: adversarial / production / test-strategist / data-migrations;
> the pragmatist persona dropped mid-run — **YAGNI/scope-creep coverage is thin, treat with care**).
> 24 confirmed findings (5 blockers). All folded below. This is the deferred Cut B of
> [github-webhook-receiver](./github-webhook-receiver.md) (spec 6); closes the "KNOWN DEEPER ISSUE"
> in [last-synced-frozen-by-idempotency-dedup](../investigations/last-synced-frozen-by-idempotency-dedup.md).

## Goal

Today every GitHub normalizer hardcodes `_event_version: 1`, so (a) genuine content changes are
suppressed by idempotency dedup until the 30-day TTL, and (b) the core-writer SETs `_event_version`
unconditionally and gates only on exact `isDuplicate`, so an older out-of-order webhook delivery can
overwrite newer state. Cut B makes the version content-derived and adds an **atomic** ordering guard.

## Scope (user-confirmed)

CORE + unify person-upsert. **NO Neo4j backfill** of legacy nodes. Land on `next-release`.
**CODEOWNERS is OUT** (see audit finding A1 — it is edge-only, has no node to carry a version).

## Success criteria (criterion 3 scoped per audit A5)

1. Unchanged entity re-sync → still deduped, no write churn.
2. Genuine content change → writes (no longer suppressed) — **for all entity types** (this is why we adopt Option B).
3. Out-of-order OLDER delivery → content write skipped, `_last_synced` not moved backward — **for timestamped entities only** (Repository, Pipeline-with-runs). Hash-versioned entities (Team, Person) are unorderable → last-writer-wins, explicitly accepted.
4. No regression for non-timestamped entities.
5. Existing `_event_version: 1` nodes keep updating after deploy (no migration, no wedge), incl. the rolling-deploy window.

## Two architectural decisions the audit forced

### D1 — The guard is an ATOMIC compare-and-set inside the Cypher write (NOT external read-then-write)

Blockers **production-01 / adversarial-4**: an app-level "read stored version → compare → conditionally
write" is a TOCTOU race. `getExistingClaims` (read txn) and `writeNode` (write txn) are separate Neo4j
transactions; BullMQ worker `concurrency` is configurable and `>1` is used in tests, core-writer is a
deployable worker that can run multiple replicas, and managed transactions auto-retry. Two deliveries
both read `stored=OLD`, both pass, and the unconditional `SET` makes last-commit-win, not newest-win.

**Fix:** push the comparison into `mergeNode`'s Cypher as a conditional set, e.g.

```cypher
MERGE (n:Label {id:$id})
SET n._event_version = CASE WHEN $comparable AND coalesce(n._event_version, -1) >= $incoming
                           THEN n._event_version ELSE $incoming END
// apply content/claim SETs only when the write is accepted (incoming wins or incomparable/first-write)
```

Implementation note: a single `MERGE` + conditional `SET` (or a `FOREACH`/`WHERE`-gated write) so the
read-compare-write is one atomic transaction. **This also dissolves blockers data-migrations-001/002**
(Neo4j returns a stored integer as a lossless `Integer` _object_, not a JS number, so the JS
"both numbers" branch is dead) — in-Cypher comparison uses Neo4j's native numeric ordering, no
`.toNumber()` dance, no JS type-sniffing on the stored side. `compareEventVersion` in JS is still used
to classify _comparable vs incomparable_ and to feed `$comparable`/`$incoming`, but the actual ordering
decision is made in Cypher against the live value.

### D2 — Adopt Option B: decouple the dedup key from the ordering token

The original plan let one field serve both idempotency dedup AND ordering. The audit proved this breaks:

- **test-strategist-002 (blocker):** equal-timestamp content change → identical key → deduped at
  `writer.ts:98` _before_ the guard → suppressed (the original bug).
- **data-migrations-004 (major):** concrete case — a Pipeline's `last_run.created_at` is fixed across a
  run's `queued→in_progress→completed` transitions, but `last_run_status`/`conclusion` (real content)
  change → identical version → suppressed under Option A.

**Fix:** the idempotency/dedup key becomes **content-derived** (`{conn}:{id}:{contentHash}`), so any
content change yields a new key → not deduped → reaches the guard. `_event_version` becomes **purely the
ordering token** (epoch ms for timestamped; sentinel/hash for hashless). Touches `buildNodeIdempotencyKey`
(idempotency.ts) AND the parallel `buildIdempotencyKey` (event-bus producer.ts) — they must stay
byte-identical modulo the `:`→`~` BullMQ substitution (adversarial-11), and both stay colon-free.

**Accepted cost (adversarial-11 + production-04):** changing the key shape orphans all existing
`_IdempotencyLog` rows + BullMQ completed-job dedup → a **one-time full re-write wave** on first
post-deploy sync. Must be sized against Neo4j write capacity and the
[redis-OOM scar](../scars/redis-memory-limit-below-dataset-oomkills.md). This is the main reason to
weigh D2 with the user before executing (see Open questions).

## Specs (revised, findings folded)

1. **Fetcher timestamp projection** (was missing — discovered): extend `GitHubRepo` (+`updated_at`, +`pushed_at`), `GitHubWorkflow` (+`updated_at`) interfaces and **both** the list fetchers
   (`repositories.ts`, `workflows.ts`) AND the single-entity fetchers (`single-entity.ts`, used by
   webhook refetch) to project them.
2. **Shared helpers:**
   - `deriveTimeVersion(...isoOrEpoch): number | null` — max epoch over parseable inputs; **returns
     `null` (a sentinel), never `0`/`NaN`/`-Infinity`, when nothing parses** (production-07,
     data-migrations-006). `Date.parse(undefined) === NaN` is a trap.
   - `deriveContentVersion(obj): string` — stable canonical-JSON sha256, **sentinel-prefixed + colon-free**
     (e.g. `ch_<hex>`), excluding `Date.now`/`ingested_at`/`_last_synced` so it is stable for unchanged content.
   - `deriveContentHash(node): string` — the dedup-key hash for D2 (may reuse `deriveContentVersion` over the content-bearing fields).
3. **Normalizers** use the helpers. Repository → time version, **fallback to content hash when no
   timestamp parses** (production-07: Repository was missing the fallback Pipeline had). Pipeline →
   last-run `created_at` epoch → workflow `updated_at` → content hash (three tiers, each tested).
   Team node + team-member Person → content hash. **CODEOWNERS: no change** (edge-only).
4. **person-upsert unify:** replace `YYYY-MM-DD` with `deriveContentVersion` over identifying fields;
   the version must be **deterministic across different `now` values** and **sensitive to name/email/login
   changes** (test-strategist-007). Update the "never compared" comment and `person-upsert.test.ts:48`.
5. **core-writer:**
   - Dedup key → content hash (D2) in `idempotency.ts` + matching `event-bus/producer.ts`.
   - `mergeNode` Cypher → atomic conditional set (D1). `compareEventVersion` JS helper classifies
     comparable/incomparable and supplies `$comparable`/`$incoming`; ordering decided in Cypher.
   - **Touch-path guard (adversarial-7):** the `isDuplicate` branch calls `touchLastSynced`
     unconditionally; on replay of a known-old version this moves `_last_synced` backward. Make the
     touch conditional — only advance `_last_synced` if the incoming is not older (do it in the
     `touchLastSynced` Cypher, `SET ... WHERE $incoming >= n._last_synced` or version-based).
   - **Skip path side effects (test-strategist-008):** on a guard-rejected (older) write, still
     `record()` the dedup key (short-circuit replays), do NOT touch `_last_synced`, and count under a
     **distinct counter** (not folded into `duplicatesSkipped`).
6. **Observability (production-09):** add a distinct `freshnessSkipped` counter to `WriteResult` + a
   debug log line with incoming-vs-stored version on every guard rejection. Note `main.ts:88` currently
   **discards** the `WriteResult` — wire it to the process logger/metrics or the counter is dead.
7. **Idempotency-log lifecycle (production-04):** `cleanupExpiredIdempotencyKeys` exists but **has zero
   call sites** — the 30-day TTL is not enforced today, so per-change keys would grow monotonically.
   Schedule it (interval/cron in core-writer `main.ts`) OR switch the log to store-latest-version-per-entity.
   At minimum, document and ticket if deferred — D2 makes this pressing.
8. **Tests** (expanded per test-strategist-003/004/006/008/009/010, data-migrations-001):
   - `compareEventVersion` matrix incl. equal-instant num/iso boundary, hash/iso, garbage non-ISO string,
     **equal hashes**, legacy-1/hash, null-vs-undefined stored, **and a Neo4j `Integer`-object stored fixture** (not JS `1`).
   - Atomic-guard behavior via a **stateful NodeWriter double** whose write updates what subsequent
     reads/writes see — assert intra-batch `[newer, older-same-id]` → older skipped (test-strategist-006).
   - A **Neo4j-backed (or faithful) query-shape test** that the live Cypher actually does the conditional
     set + projects the version (test-strategist-010) — mocked unit tests can't catch query/mocks drift.
   - End-to-end legacy regression: stored `_event_version=1` (as an Integer object) + incoming epoch → writes & normalizes; + incoming hash → writes (test-strategist-004).
   - person-upsert determinism (two `now`s → equal version) + field sensitivity.
   - Polling regression: unchanged→dedup, changed→write, stale→skip. Equal-timestamp content-change characterization test (test-strategist-002).
   - Update existing `writer.test.ts`/`integration.test.ts` fixtures that hardcode `_event_version` 1/2 (update **both** the `createMockNodeWriter` and the inline integration mock).

## Edge cases

Equal-timestamp content change (handled by D2); node exists but stored version missing/legacy/Integer-object;
Pipeline zero recent_runs; Repo partial webhook projection with null updated_at (→ content-hash fallback,
never NaN); hash entity changing twice out-of-order (last-writer-wins, accepted); intra-batch old+new same id
(handled by D1 atomic CAS); two connectors / re-scoped ids.

## Backward compatibility, rollout, rollback

- **Backward compat:** no backfill. Existing `_event_version: 1` (stored as Neo4j Integer) — D1's in-Cypher
  comparison treats it natively; any real epoch `>> 1` wins; hash vs `1` is incomparable → write. First
  post-deploy sync normalizes the field (+ the one-time re-write wave from D2's key-shape change).
- **Rolling deploy (data-migrations-007):** during rollout an OLD api-server replica still emits
  `_event_version: 1` while a NEW core-writer runs the guard → the `=1` delivery is seen as older → skipped
  - its dedup key burned. **Sequence the deploy** (core-writer guard after all api-server/connector replicas
    emit real versions) or flag-gate the guard until full rollout. Add to runbook.
- **Rollback (production-05):** NOT a clean code-revert. Post-revert, normalizers re-emit `=1`, whose key
  may still be in `_IdempotencyLog` (cleanup is unscheduled → effectively never) → re-suppresses content
  writes. Rollback runbook MUST include purging the affected `_IdempotencyLog` entries. Contradicts the
  naive "no data migration" claim — call it out.

## Out of scope (audit-surfaced, explicitly deferred)

- **CODEOWNER edge out-of-order ordering** (adversarial-1): `mergeEdge` is an unconditional `SET` with no
  version/guard; edge deliveries are last-writer-wins. Tracked as a new open question, not fixed here.

## Task DAG

```mermaid
graph TD
  T1[T1 fetcher timestamp projection: list + single-entity] --> T3
  T2[T2 shared helpers: deriveTimeVersion(sentinel-on-empty) + deriveContentVersion + deriveContentHash + tests] --> T3
  T2 --> T4
  T2 --> T5
  T3[T3 normalizers use helpers + 3-tier fallback]
  T4[T4 person-upsert unify + determinism tests]
  T5[T5 compareEventVersion classify + matrix incl Integer-object] --> T6
  T6[T6 atomic in-Cypher guard in mergeNode + conditional touchLastSynced] --> T8
  T7[T7 D2 content-hash dedup key: idempotency.ts + producer.ts byte-identical] --> T8
  T8[T8 writer wiring: skip-path side effects + freshnessSkipped counter] --> T9
  T9[T9 stateful-mock + Neo4j-backed + polling regression + legacy e2e tests] --> T11
  T10[T10 idempotency-log cleanup scheduling] --> T11
  T11[T11 docs/runbook/closeout: rollout seq, rollback purge, investigation status, canonical comment]
```

- Wave 1 (parallel): T1, T2, T7, T10. Then T3/T4/T5 → T6 → T8 → T9 → T11.

## Verification

`pnpm -r typecheck`; per-package vitest (shared, connector-github, core-writer, api-server) green incl.
updated fixtures; a Neo4j-backed query test for the atomic guard if the harness supports it (else a
faithful Integer-object mock); manual: confirm the dual-source Person and a Pipeline run-status transition
both write.

## Open questions (decide before/at execution)

1. **Adopt Option B (D2) now, or accept Option A's documented suppression gaps?** B is correct but forces a
   one-time full re-write wave + makes the unscheduled-cleanup fix mandatory. → `open-questions/cutb-option-b-rewrite-wave.md`.
2. **Schedule `cleanupExpiredIdempotencyKeys` as part of Cut B, or split it out?** It is a pre-existing
   latent unbounded-growth bug that D2 amplifies.

## Related

- [github-webhook-receiver](./github-webhook-receiver.md) — Cut A; this is its spec 6
- [last-synced-frozen-by-idempotency-dedup](../investigations/last-synced-frozen-by-idempotency-dedup.md) — the bug this closes
- [redis-memory-limit-below-dataset-oomkills](../scars/redis-memory-limit-below-dataset-oomkills.md) — re-write-wave / growth sizing
- [bullmq-5-forbids-colons-in-queue-names-and-job-ids](../scars/bullmq-5-forbids-colons-in-queue-names-and-job-ids.md) — colon-free key constraint
