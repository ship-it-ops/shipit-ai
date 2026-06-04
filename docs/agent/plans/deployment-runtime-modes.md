---
type: plan
status: active
created: 2026-06-04
updated: 2026-06-04
author: claude-session-2026-06-04-deployment
tags: [deployment, hosting, runtime-mode, event-bus, connector-runner, cost]
importance: core
---

# Deployment Runtime Modes: `distributed` vs `embedded`

> **Status: DESIGN — pending user approval.** Nothing here is implemented yet.
> This note captures the full reasoning from the 2026-06-04 hosting/deployment
> brainstorm so it can be reviewed and turned into an implementation plan later.
> When approved, the runtime-mode choice should be promoted to a `decisions/`
> note and the build steps to their own active plan.

## Goal

Let ShipIt-AI run in two deployment shapes from **one codebase, selected by a
single config switch**, so a hobby deploy can be near-free today and scale up
later without a rewrite:

- **`distributed`** (today's shape): Redis + BullMQ, a separate `core-writer`
  worker process, an always-on `api-server` with an embedded poller. Targets a
  container platform (Fly / Cloud Run / VPS).
- **`embedded`** (new): one always-on process. In-process event bus, in-process
  scheduler, no `core-writer` process, no BullMQ, Redis optional/none. Targets a
  single small container (Fly now) + Neo4j Aura Free + Vercel for the web-ui.

## Why (context)

The user wants the cheapest viable hosting and already uses Vercel. Key findings
from the brainstorm:

1. **Only the web-ui fits Vercel.** Three backend pieces are long-lived,
   stateful processes, which serverless is the wrong shape for:
   - `api-server` (Fastify) — always-on; runs the connector **scheduler** and is
     a BullMQ **producer**.
   - `core-writer` — always-on BullMQ **consumer** with no HTTP surface at all.
   - `mcp-server` (HTTP) — long-lived server.
2. **Syncs are "bucket C"** (user-confirmed): a full org sync can run many
   minutes or be effectively unbounded. This is the decisive constraint — see
   "Why not fully serverless" below.
3. **Neo4j is always an external managed service.** Vercel's database
   marketplace (verified 2026-06-04) offers Postgres/Redis/SQLite/Mongo/analytics
   but **no graph database**. Neo4j Aura is external on every cloud, regardless of
   platform. The graph model is load-bearing (Cypher in the writer, claims,
   reconciliation) — re-platforming onto Postgres would be a ground-up rewrite and
   is explicitly rejected.
4. **Redis quietly does more than the queues:** auth sessions
   (`redis-session-store.ts`) and the connector run store (Redis LIST). Dropping
   BullMQ does not automatically drop Redis — those two uses must be handled
   (for hobby/auth-off, sessions don't matter; run store needs a fallback).

## Current topology (what we're toggling)

Two **separate** BullMQ queues over Redis:

1. **`shipit-sync-github`** — produced _and consumed inside `api-server`_
   (`SyncScheduler` constructs both a `Queue` and a `Worker`,
   `packages/api-server/src/services/sync-scheduler.ts`). Repeatable cron jobs
   (each connector's `schedule`) poll GitHub. BullMQ here = cron + bounded
   concurrent execution. The running sync (`ConnectorHarness.runSync`) emits
   canonical entities via `eventBus.publish(...)` into queue 2.
2. **`shipit-events`** (the event bus) — produced in `api-server`, consumed by
   **`core-writer`** (`packages/core-writer/src/main.ts`), which writes Neo4j.
   BullMQ here = durable buffer decoupling sync from graph writes. Job `jobId =
idempotency_key` gives queue-level dedup; a parallel Redis Stream
   (`shipit-event-log`) backs `replay()`.

## The two seams that make this a toggle (not a rewrite)

Both queues hang off interfaces that already exist:

- **`ConnectorRunner`** — the registry injects it; `SyncScheduler` is the BullMQ
  impl, `NoopRunner` the test default (pattern note
  `connector-runner-injection`). Controls scheduling/polling.
- **`EventBusClient`** (`@shipit-ai/shared`) — `BullMQEventBusClient` is one
  impl. Controls sync → writer transport. `core-writer`'s `CoreWriter.start()`
  only needs _an_ `EventBusClient` to `subscribe()` to.

Swapping both to in-process implementations removes Redis + core-writer + BullMQ
while the sync and writer logic in between stay **byte-for-byte identical**.

## Design

### Config switch

Add a runtime block under `backend` in `shipit.config.yaml` (and the schema +
example):

```yaml
backend:
  runtime:
    mode: distributed # distributed | embedded   (default: distributed)
```

`mode` is read once at api-server boot and selects which `ConnectorRunner` and
`EventBusClient` implementations are constructed, plus whether the writer and MCP
are embedded.

### `distributed` mode (unchanged from today)

- `ConnectorRunner` = `SyncScheduler` (BullMQ repeatable jobs).
- `EventBusClient` = `BullMQEventBusClient`.
- `core-writer` deployed as its own process.
- Redis required (queues + sessions + run store).
- Replay stream available.

### `embedded` mode (new)

- `ConnectorRunner` = **new** in-process runner (e.g. `node-cron` /
  `setInterval`) that calls the same per-job logic `SyncScheduler.processJob`
  runs — fresh `GitHubConnector` + `ConnectorHarness` per tick, bounded
  concurrency. No Redis.
- `EventBusClient` = **new** `InProcessEventBusClient` whose `publish()` invokes
  the writer handler **synchronously in-memory** (no Redis, no second process).
  `subscribe()` registers the in-process `CoreWriter` handler.
- `CoreWriter` is constructed **inside api-server** and subscribed to the
  in-process bus. No `core-writer` process deployed.
- **MCP**: optionally folded into api-server (it already depends on
  `@shipit-ai/mcp-server` and has `routes/mcp.ts`) so embedded = a single
  container. Keep as a flag; not required for v1.
- Redis **dropped**. Consequences to handle:
  - Sessions: only needed when auth is on; hobby/personal runs with auth off, so
    no session store needed. (If auth-on + embedded is ever wanted, fall back to
    an in-memory or signed-cookie session store.)
  - Connector run store: move from Redis LIST to an in-memory ring buffer or a
    small Neo4j-backed store (`connector-run-store.ts`).
  - Replay stream: gone. Acceptable — replay is currently unused (see
    open-question `replay-stream-wire-or-cut`). The **Neo4j idempotency-checker
    still protects against double-writes**, so losing queue-level dedup is fine.

### What is preserved regardless of mode (important)

The **manual-overlay / claims model is orthogonal to this toggle.** Provenance
lives in Neo4j (`_claims[]` on nodes, `_source` on edges), not in Redis or the
queue. Manual edits survive re-sync because `ClaimResolver.mergeClaims` replaces
only same-`source` claims and edges are MERGE-upserted with no pruning. Dropping
Redis / going `embedded` does **not** weaken this. (See open-question
`manual-edit-write-path` for the not-yet-built write endpoints.)

## Why not fully serverless (the bucket-C wall)

- Vercel functions are lifetime-capped: **Hobby 300s (5 min) hard**, Pro up to
  **800s (~13 min)**. `waitUntil()` / `after()` run work _after the response_ but
  inside the same instance — still bounded by `maxDuration`. A multi-minute /
  unbounded bucket-C sync gets killed mid-crawl → partial/corrupt run.
- Vercel's own guidance: "Hours/days → use Workflow DevKit (WDK)." The only
  serverless-native path is **chunking the sync into many short durable steps**
  (per-repo/per-page, resumable, checkpointed) — a real re-architecture of the
  crawler, still needing durable cursor state, still rate-limited by GitHub
  (5k/hr per installation).
- Fluid **Active CPU pricing** bills while the CPU works; a sustained crawl is
  CPU-active throughout, so serverless can cost _more_ than a tiny always-on VM
  for this workload.
- Conclusion: an **always-on worker is non-negotiable**. `embedded` mode runs the
  sync as a background task inside a persistent container (Fly/Cloud Run) — the
  user's "run compute in the background on the deployed app" instinct, applied to
  a long-lived process rather than a serverless function.

## Hosting / deploy targets

| Piece                              | `embedded` (now)         | `distributed` (scale)                                    |
| ---------------------------------- | ------------------------ | -------------------------------------------------------- |
| web-ui                             | Vercel Hobby ($0)        | Vercel / CDN                                             |
| api-server (+writer +MCP embedded) | 1 Fly Machine (~$0–5/mo) | Cloud Run / Fargate, `min-instances=1` on the worker     |
| core-writer                        | (folded in)              | separate Cloud Run / Fargate service                     |
| Redis                              | none                     | Memorystore / ElastiCache / Upstash                      |
| Neo4j                              | **Aura Free** ($0)       | Aura Professional (~$65/mo floor) or self-hosted on a VM |

Notes:

- web-ui bakes the API URL at **build time** (`SHIPIT_API_URL`,
  `NEXT_PUBLIC_*`) — set it per deploy.
- Personal/hobby confirmed → Vercel Hobby (non-commercial) and Aura Free are
  allowed.
- **Cost cliff is the database, not compute:** the ~$5 → ~$100/mo jump at scale
  is almost entirely Neo4j Aura Professional. Self-hosting Neo4j on a VM is the
  lever to fight that later.

## Files to touch (implementation sketch — not final)

- `packages/shared/` — add `backend.runtime.mode` to config types + Zod schema;
  `config/shipit-schema.yaml`, `shipit.config.yaml`, `*.example.yaml`.
- `packages/event-bus/src/inprocess/client.ts` — **new** `InProcessEventBusClient`
  implementing `EventBusClient` (synchronous publish→handler; no-op/empty
  `replay`).
- `packages/api-server/src/services/inprocess-runner.ts` — **new**
  `ConnectorRunner` using node-cron; reuse the job body from `SyncScheduler`
  (extract `processJob` into a shared function to avoid duplication).
- `packages/api-server/src/index.ts` — select runner + bus by `mode`; in
  `embedded`, construct `CoreWriter` + subscribe it; optionally mount MCP.
- `packages/api-server/src/services/connector-run-store.ts` — add non-Redis
  backend (in-memory ring or Neo4j) for `embedded`.
- Auth/session wiring — guard Redis session store behind `auth.enabled && mode === 'distributed'`.
- Deploy: `fly.toml` for the embedded container; keep existing Dockerfiles;
  Vercel project for web-ui. (`distributed` later: Cloud Run service defs.)
- Docs: update `docs/architecture.md` + `docs/deployment.md` with both modes.

## Status

Design captured and pending review. Next step after approval: run the
`writing-plans` skill to produce the step-by-step implementation plan, starting
with the config switch + `InProcessEventBusClient` (smallest vertical slice that
proves the seam).

## Open items folded into this design

- `replay-stream-wire-or-cut` — decide before building `distributed`'s bus
  whether to keep/wire or cut the Redis Stream. `embedded` drops it for free.
- `manual-edit-write-path` — the webapp write endpoints for manual claims/edges
  aren't built yet, and there's a `manual` source-priority inconsistency to fix.
  Independent of this toggle but on the same roadmap.

## Related

- [connector-runner-injection](../patterns/connector-runner-injection.md) — the scheduling seam
- [connector-run-storage-redis-not-yaml](../decisions/connector-run-storage-redis-not-yaml.md) — run store currently in Redis
- [core-writer-runs-as-its-own-process](../decisions/core-writer-runs-as-its-own-process.md) — the process this toggle optionally folds in
- [replay-stream-wire-or-cut](../open-questions/replay-stream-wire-or-cut.md)
- [manual-edit-write-path](../open-questions/manual-edit-write-path.md)
