---
type: open-question
status: answered
opened: 2026-06-19
answered: 2026-06-19
answer-source: maintainer
tags: [core-writer, idempotency, cutb, data-integrity]
---

# Cut B: adopt Option B (content-hash dedup key) despite a one-time full re-write wave + mandatory cleanup fix?

## Context

The Cut B audit (5-persona) showed Option A (one field for both dedup and ordering) provably suppresses
genuine content changes (equal-timestamp; concretely a Pipeline's `last_run_status`/`conclusion` changing
while `last_run.created_at` stays fixed across `queued→in_progress→completed`). Option B decouples them:
dedup key = content hash, `_event_version` = ordering token. Option B is correct but:

- Changing the idempotency-key shape **orphans every existing `_IdempotencyLog` row + BullMQ completed-job
  dedup state** → the first post-deploy sync re-writes EVERY entity once (mass write wave). Must be sized
  against Neo4j write capacity (see redis-OOM scar for the spirit of "bound the blast").
- `cleanupExpiredIdempotencyKeys` currently has **zero call sites** — the 30-day TTL is not enforced, so
  per-content-change keys grow monotonically. Option B makes scheduling this (or storing
  latest-version-per-entity) effectively mandatory.

## Tried

Audit confirmed both costs against source. Plan [webhook-cut-b-content-freshness](../plans/webhook-cut-b-content-freshness.md)
recommends Option B + scheduling cleanup; this question gates execution.

## Who can answer

Maintainer / user — it is a deploy-risk vs correctness tradeoff (one-time re-write wave + a cleanup
scheduler) they should sign off before the plan executes.

## ANSWER (2026-06-19, user)

**Option B + schedule cleanup.** Build the content-hash dedup key + atomic in-Cypher guard AND wire
`cleanupExpiredIdempotencyKeys` to actually run. The one-time re-write wave is accepted (trivial at the
current ~10-repo / 2-team scale). This is the recommended, complete fix.
