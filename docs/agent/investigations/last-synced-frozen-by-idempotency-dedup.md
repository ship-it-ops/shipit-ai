---
type: investigation
status: fixed
created: 2026-06-16
updated: 2026-06-16
author: claude-opus-4-8
tags: [core-writer, idempotency, last-synced, staleness, connectors]
importance: core
---

# Catalog entity "Synced" is frozen (2w ago) while connector "last synced" is fresh (2m ago)

## Symptoms

On the deployed demo, a catalog entity (e.g. Team `admins`) Summary shows
`SYNCED: 2w ago`, but the Connector Hub shows the same connector
`last synced 2m ago`.

## Root Cause

Two different timestamps, and a bug freezes the node one:

- Connector "last synced" = connector _run_ time in Redis
  (`api-server/.../connector-run-store.ts`), updated every run.
- Catalog "Synced" = node property `_last_synced`, only set when the entity is
  actually written to Neo4j.

The freeze: every GitHub normalizer hard-codes `_event_version: 1`
(`connectors/github/src/normalizers/*.ts`). The core-writer idempotency key is
`{connectorId}:{node.id}:{_event_version}` (`core-writer/src/idempotency.ts`),
so for a given entity the key is constant across runs. After the first write the
key is stored in an `_IdempotencyLog` with a 30-day TTL
(`core-writer/src/config.ts` → `idempotencyTtlDays: 30`). On every later run the
identical node hits `isDuplicate() === true` → `continue`
(`core-writer/src/writer.ts:91-94`) → `nodeWriter.writeNode()` never runs →
`_last_synced` is never bumped. The Cypher upsert DOES always `SET _last_synced`
(`core-writer/src/neo4j/queries.ts`), but it's never reached for unchanged
entities. So `_last_synced` reflects the FIRST write (~seed time), unsticking
only after the 30-day TTL expires, then refreezing.

Side effect: the staleness feature (`_last_synced_age_seconds`, computed in
`api-server/.../neo4j-service.ts withStalenessAge`) flags unchanged entities as
stale instead of flagging entities whose connector stopped — the opposite of
useful.

The idempotency layer was meant to dedup event **redelivery/replay**, not
routine periodic re-syncs; the constant `_event_version` makes every re-sync
look like a redelivery.

## Fix (shipped to working tree 2026-06-16 — Option A, bump-on-every-sync)

On an idempotent skip, refresh `_last_synced` with a cheap single-property `SET`
(no claim resolution / full write), so "Synced" means "last confirmed from
source". `core-writer/src/writer.ts` now reconciles before the dup check (to get
the canonical id) and on skip calls `nodeWriter.touchLastSynced(canonicalId,
node._last_synced)` (best-effort, errors swallowed). New interface method
`NodeWriter.touchLastSynced`; Neo4j impl in `node-writer.ts` +
`touchLastSynced` query (`MATCH (n {id}) SET n._last_synced`) in `queries.ts`.
Connector does a full fetch each run (`connectors/github/src/connector.ts sync`
has no since-cursor), so every entity re-reaches the writer and gets bumped.
Tests: `writer.test.ts` (refresh-on-skip), both NodeWriter mocks updated; 68
core-writer tests green, typecheck clean.

Alternatives considered: content-hash `_event_version` (still leaves unchanged
entities showing stale "Synced" — doesn't fix the complaint); short idempotency
TTL (reintroduces full re-writes every run); UI relabel to "Last changed" +
show connector run time (more accurate label but doesn't make "Synced" fresh).

## UPDATE 2026-06-19 — deeper issue fixed by Webhook Cut B

The "KNOWN DEEPER ISSUE" below (constant `_event_version` suppressing real content
changes) is now addressed. `_event_version` is content-derived (epoch ms for
timestamped entities; `ch_` content hash otherwise), the idempotency/dedup key is a
separate content fingerprint (`deriveNodeContentHash`) so a genuine change is never
deduped away, and the core-writer has an atomic in-Cypher freshness guard that skips
only strictly-older deliveries (and never moves `_last_synced` backward). See
[webhook-cut-b-content-freshness](../plans/webhook-cut-b-content-freshness.md).

## KNOWN DEEPER ISSUE (separate — FIXED by Cut B, see update above)

The constant `_event_version: 1` also suppresses real CONTENT changes: if a
repo's language/visibility/etc. changes, the normalizer still emits
`...:<id>:1`, which is already in the 30-day `_IdempotencyLog`, so `writeNode`
is skipped and the NEW content is never written (until TTL expiry). Option A
makes such an entity show a fresh "Synced" while its data is stale — arguably
worse for that case. The complete fix is to also set `_event_version` to a
content hash (Option C) so genuine changes produce a new key and get written,
while true duplicates still dedup. Recommended follow-up.

## Related

- [core-writer-runs-as-its-own-process](../decisions/core-writer-runs-as-its-own-process.md)
- [connector-run-storage-redis-not-yaml](../decisions/connector-run-storage-redis-not-yaml.md)
- [connectorinfo-status-degraded-is-overloaded-as-syncing](../scars/connectorinfo-status-degraded-is-overloaded-as-syncing.md)
