---
type: decision
status: active
created: 2026-05-24
updated: 2026-05-24
author: claude-opus-4-7
tags: [connector, run-history, redis, registry, telemetry]
importance: core
---

# Connector run history lives in Redis, not `shipit.config.local.yaml`

## Context

The original `ConnectorRegistry` implementation persisted the last 20 sync runs per connector inside `shipit.config.local.yaml` under each instance's `lastRuns:` field. Every successful or failed poll tick called `registry.recordRun()` which:

1. Re-validated the entire connector through Zod.
2. Wrote the full instance back to in-memory state.
3. Round-tripped the whole local YAML through `parseDocument` + `setIn` + tmpfile + rename.

This is the wrong shape for run history because:

- **Wrong concern.** `shipit.config.local.yaml` is user-edited configuration — repos, schedule, scope, App overrides. Run history is operational telemetry written by the system. Mixing them means every poll tick races user edits for the same file lock, and a hand-edit to scope while a sync completes risks clobbering one or the other.
- **Wrong shape.** Run history is a capped FIFO; YAML is a hierarchical document optimized for human readability and infrequent change. Each `persist()` pays for `parseDocument` of the full file, mutation, full re-serialization, tmpfile write, and rename — for what should be an O(1) "prepend to list, cap at N" operation.
- **Wrong cadence.** The poll runs every 15 minutes per connector. Five connectors at 15-min poll = ~480 YAML writes/day, all of operational data that doesn't belong in git.
- **Leaks operational state into version control.** Even though the local YAML is gitignored, the _example_ YAML and the schema both surfaced `lastRuns` as a first-class field, inviting accidental copy-paste into the committed `shipit.config.yaml`.

## Decision

Run history moves out of YAML into a Redis-backed `ConnectorRunStore`:

- **Storage layout.** One Redis LIST per connector at key `shipit:connector-runs:<connectorId>`, newest entry at index 0. Capped at 20 via `LTRIM` after each `LPUSH`.
- **Service contract.** `ConnectorRunStore` interface with three methods: `recordRun(id, run)`, `listRuns(id, limit?)`, `listManyLatest(ids[], limit?)` (pipelined batch read for the list-connectors endpoint), `clear(id)`. Two implementations: `RedisConnectorRunStore` (production) and `InMemoryConnectorRunStore` (tests and Redis-absent fallback).
- **Registry refactor.** `ConnectorRegistry` accepts a `runStore` in its constructor (defaulting to `InMemoryConnectorRunStore` so existing unit tests don't need to wire up Redis). `recordRun()` delegates to the store and no longer touches in-memory state or the YAML. `remove()` calls `runStore.clear()` so a deleted connector doesn't leave orphaned run history that a re-created connector with the same id would inherit. `persist()` strips `lastRuns` from the serialized output via destructure.
- **API contract preserved.** Routes hydrate `lastRuns` server-side from the run store. `GET /api/connectors` uses `listManyLatest` (one Redis round trip for N connectors); `GET /:id` and `GET /:id/runs` use single `listRuns` calls. `PATCH /:id` also hydrates so the UI's cache shape matches `GET`.
- **ETag scope narrowed.** `getHash()` excluded run history from the start (it only canonicalized the configuration fields), but the new shape makes that explicit: the registry's in-memory copy now always has `lastRuns: []`, so there's no chance of a runtime field flapping the ETag on every poll.
- **Migration.** Existing `lastRuns:` entries in `shipit.config.local.yaml` were one-shot migrated into Redis (RPUSH preserving newest-first order, then LTRIM 0 19) and then stripped from the YAML. New writes never re-introduce the field.

## Alternatives Considered

- **Neo4j as `_SyncRun` nodes linked to `_Connector` nodes.** Rejected. Conflates operational metrics with the domain knowledge graph. The `_`-prefix-internal-label convention (see `internal-node-label-underscore-prefix.md`) would keep the explorer clean, but every poll would mean a `MERGE` into the graph. Read paths would need separate Cypher queries, none of which the UI currently needs. Heavier than the problem.
- **BullMQ-derived run history (no separate store).** Rejected. BullMQ's job retention is tuned for queue mechanics, not for "what was the result of the last 20 syncs". Our run shape (`entitiesSynced`, structured `errors[]`) doesn't naturally fit into `returnvalue`, and forcing BullMQ to retain jobs forever to act as a query surface would create unbounded growth in a different key namespace.
- **SQLite as a sidecar operational store.** Rejected. New infra dependency for a use case that fits Redis's data shape perfectly. Redis is already a hard requirement (BullMQ + the event bus); SQLite would be net-new surface area.
- **Keep `lastRuns` in YAML but write less often (e.g. only on user-triggered syncs).** Rejected. Solves none of the underlying concerns and silently desyncs the UI's "last sync" timestamp from the actual most-recent cron tick.

## Consequences

- `shipit.config.local.yaml` shrinks: no per-poll churn, no `lastRuns:` array. The example YAML follows.
- Run history survives api-server restarts (was true before because it was in YAML; still true because it's now in Redis). It does **not** survive a `docker compose down -v` that wipes the Redis volume — by design, that's the "fresh dev environment" command.
- The api-server now requires `ioredis` directly (added as a direct dep via the existing `^5.4.0` declaration). The shutdown handler disconnects the client cleanly on SIGTERM/SIGINT.
- New test surface: 9 tests in `packages/api-server/src/__tests__/services/connector-run-store.test.ts` pin the `InMemoryConnectorRunStore` contract (which `RedisConnectorRunStore` must match — they share the interface). 35 existing connector-routes tests pass unchanged because the registry's default `InMemoryConnectorRunStore` is the same in-memory implementation, behaviorally indistinguishable from the previous in-YAML behavior at the API layer.
- Removing a connector via `DELETE /api/connectors/:id` now also clears its run history. Re-creating with the same id starts with an empty `/runs` tab — the right thing.
- A connector deleted by hand-editing the YAML out (the out-of-band path) will leak its run history in Redis. We accept that — sweeping for orphans would require the registry to enumerate Redis keys on every boot, which adds startup latency for what should be a very rare path. If it becomes a real problem, a periodic reconciliation task can scan `KEYS shipit:connector-runs:*` and prune ones missing from the registry.

## Revisit Triggers

- **Run history needs cross-connector queries** (e.g. "show me every failed run in the last 24h across all connectors"). Redis LIST doesn't index across keys. At that point either:
  - Mirror runs into Neo4j as `_SyncRun` nodes (decision above's runner-up); or
  - Move to a relational store with proper indexing.
- **Connector volume grows past ~100.** `listManyLatest` pipelines today; if listing connectors becomes a hot path with very high N, switch the list endpoint to skip run hydration entirely and force clients to call `/:id/runs` lazily.
- **Run shape grows beyond a small JSON blob.** The store serializes each run with `JSON.stringify`. If individual runs balloon (e.g. attaching diff payloads), this becomes the wrong place — Redis lists aren't a document store.
- **We need TTL-based eviction** (e.g. "drop runs older than 30 days even if the connector is still active"). Trivial to add: per-key TTL on the LIST plus a refresh on each `LPUSH`.

## Critical files

- `packages/api-server/src/services/connector-run-store.ts` — new service + interface.
- `packages/api-server/src/services/connector-registry.ts` — accepts `runStore`, delegates `recordRun`/`clear`, strips `lastRuns` from `persist()`, exposes `getRunStore()`.
- `packages/api-server/src/routes/connectors.ts` — hydrates `lastRuns` on `GET /`, `GET /:id`, `GET /:id/runs`, `PATCH /:id`.
- `packages/api-server/src/index.ts` — constructs `RedisConnectorRunStore` from `config.backend.redis.url`, falls back to `InMemoryConnectorRunStore` when Redis is absent, disconnects on shutdown.
- `packages/shared/src/config/schema.ts` — `lastRunSchema` and `LastRun` exported so the new store can type its argument.
- `packages/api-server/src/__tests__/services/connector-run-store.test.ts` — 9 tests on the contract.
- `shipit.config.local.yaml` — `lastRuns:` block removed (migrated to Redis first).

## Verification

- `pnpm turbo typecheck` and `pnpm turbo test` both green (14/14 tasks, 90 api-server tests).
- One-shot migration moved 10 historical runs from YAML into Redis; LIST length verified, newest entry at index 0.
- `GET /api/connectors` returns lastRuns hydrated from Redis (10 entries after migration, 11 after a fresh sync).
- `POST /api/connectors/<id>/sync` records the new run to Redis without touching YAML (confirmed: `grep -c lastRuns shipit.config.local.yaml` = 0 after the sync completes).

## Related

- [github-connector-architecture-v1](github-connector-architecture-v1.md) — the polling-and-webhooks runtime this store backs.
- [etag-optimistic-concurrency-for-editable-config](etag-optimistic-concurrency-for-editable-config.md) — the ETag pattern is now strictly about configuration; this decision is what removed the only operational field that was muddying it.
- [connector-runner-injection](../patterns/connector-runner-injection.md) — companion pattern (runner injection); the runStore follows the same "interface + default fake + production swap" shape.
- [core-writer-runs-as-its-own-process](core-writer-runs-as-its-own-process.md) — sibling decision in the same broader pipeline.
