---
type: decision
status: active
created: 2026-05-22
updated: 2026-05-22
author: claude-opus-4-7
tags: [core-writer, event-bus, neo4j, process-topology]
importance: core
---

# Core-writer runs as its own process and owns the Neo4j-side adapters

## Context

After the GitHub connector + SyncScheduler started actually running and publishing entities to BullMQ, the dashboard still showed zero nodes/edges. The connector reported `status: success, entitiesSynced: 29`, but the events sat in `bull:shipit-events:wait` indefinitely. Investigation: `CoreWriter` is the class that subscribes to the event bus and writes to Neo4j, but it had **no entry point**. The `core-writer` package's `dev` script was `tsc --watch` (pure compilation) and no other process in the system constructed it. The library existed; nobody was running it.

The shape of `start:backend` (`turbo dev --filter=@shipit-ai/api-server --filter=@shipit-ai/core-writer --filter=@shipit-ai/mcp-server`) clearly _intended_ three separate processes, so the gap was the missing main + Neo4j-backed adapters, not a topology decision.

## Decision

The core-writer is a long-lived background process — **not** part of the api-server — that:

1. Loads the same `shipit.config.yaml`/`shipit.config.local.yaml` the api-server loads (via `loadConfig` from `@shipit-ai/shared`).
2. Opens a Neo4j driver against `backend.neo4j.{uri,user,password}`.
3. Subscribes to the BullMQ event bus at `backend.redis.url` (the same queue the api-server's `SyncScheduler` publishes into).
4. Batches incoming envelopes via `BatchProcessor` and runs them through the `ClaimResolver → IdentityReconciler → IdempotencyChecker → NodeWriter` pipeline.

The Neo4j-backed adapters live under `packages/core-writer/src/neo4j/`:

- `node-writer.ts` — `Neo4jNodeWriter` implements `NodeWriter` (writeNode/writeEdge/getExistingClaims).
- `linking-key-index.ts` — `Neo4jLinkingKeyIndex` implements `LinkingKeyIndex` (lookup/hasCanonicalId/register/registerAlias).
- `idempotency-checker.ts` — `Neo4jIdempotencyChecker` implements `IdempotencyChecker` against `_IdempotencyLog` nodes with a TTL.
- `main.ts` — wires them together and calls `CoreWriter.start(eventBus)`. Started by `pnpm dev` → `tsx watch src/main.ts`.

## Alternatives Considered

- **Run CoreWriter inside the api-server process.** Rejected: couples the long-running Neo4j-write worker to the Fastify API lifecycle; sync backpressure would impact request latency; the existing `start:backend` script already filters for three separate dev processes, indicating the topology was always meant to be split. Also: a crash in the writer would take down the API.
- **Run the writer as a CLI invoked per sync.** Rejected: BullMQ is a continuous-stream model. The repeatable poll schedule emits envelopes outside any sync's lifecycle (and webhook ingestion will eventually do the same), so a per-sync writer would race or miss events.
- **Run a separate worker package distinct from core-writer.** Rejected as unnecessary indirection — `core-writer` already owns the writer logic; the missing piece was just a `main.ts`. A separate `writer-worker` package would force a new dependency line and a parallel test surface for no benefit.

## Consequences

- `pnpm start:backend` now actually starts three processes: api-server, core-writer, mcp-server. Each owns its own port/keyspace.
- Editing `core-writer/package.json`'s `dev` script no longer leaves the worker silently dead — `tsx watch src/main.ts` runs the worker and reloads on edits.
- The core-writer process needs Neo4j AND Redis reachable at boot; it `process.exit(1)`s loudly if either is missing rather than running a useless no-op.
- Adding new entity types requires changes in core-writer's normalizer dependencies (none today, but a heads-up if/when the writer needs schema-aware handling).
- Tests still use the in-memory adapters under `identity/linking-key-index.ts` and `idempotency.ts`. Production swaps happen only in `src/neo4j/*` and are exercised end-to-end by hand (the run that uncovered this regression was 28 entities through to Neo4j with zero errors).

## Revisit Triggers

- If the connector volume justifies horizontally scaling the writer, the current single-process model needs to become a worker pool (BullMQ already supports multiple workers on the same queue with `concurrency`; the bottleneck would shift to Neo4j write contention before then).
- If we ever want connectors that emit events outside of a sync run (webhooks, on-demand reconciliations), this decision holds — the writer is already a stream consumer, not a sync-bound worker.
- If the api-server grows a need to _read_ recently-written graph data with strict freshness guarantees, we may need to add a "writer caught up" signal (e.g., a sequence number the api-server can poll) rather than relying on Neo4j's eventual consistency.

## Related

- [github-connector-architecture-v1](../decisions/github-connector-architecture-v1.md) — describes the connector → event bus → core-writer → graph pipeline.
- [connector-runner-injection](../patterns/connector-runner-injection.md) — the api-server-side half of the equation.
- [bullmq-5-forbids-colons-in-queue-names-and-job-ids](../scars/bullmq-5-forbids-colons-in-queue-names-and-job-ids.md) — the silent failure that masked the missing writer process during the same end-to-end test.
