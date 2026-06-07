---
type: plan
status: superseded
created: 2026-06-04
updated: 2026-06-04
author: claude-session-2026-06-04-deployment
tags: [deployment, hosting, runtime-mode, event-bus, connector-runner, cost]
importance: core
---

# Deployment Runtime Modes: `distributed` vs `embedded`

> **⚠️ SUPERSEDED (2026-06-04) by [k8s-deployment-architecture](k8s-deployment-architecture.md).**
> The hosting direction landed on **deploying the existing distributed stack
> as-is on GKE** — see decision
> [hosting-gke-distributed-not-vercel](../decisions/hosting-gke-distributed-not-vercel.md).
> The Vercel/serverless constraints that motivated the `embedded`/`serverless`
> modes, the stateless-cookie auth, and the state-relocation work were all
> dropped. This file is retained for its **reasoning trail** (why Vercel/
> serverless was rejected, the two-queue topology analysis, bucket-C, the
> manual-overlay findings) — NOT as an active plan. Do not implement from it.

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
   (`redis-session-store.ts`), the 5-minute OAuth/PKCE state
   (`state-store.ts`), and the connector run store (Redis LIST). Dropping BullMQ
   does not automatically drop Redis — these uses must each be handled. **API
   tokens are NOT a problem — they already persist on Neo4j `_AccessToken` nodes
   (`token-service.ts`), not Redis.**
5. **Auth must stay ON by default in `embedded` mode** (user requirement,
   2026-06-04). The hobby deployment is shipped to Vercel for people to log in
   and explore, so sessions must operate well without Redis — not be disabled.
   This corrects an earlier wrong assumption ("hobby runs with auth off").

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
  - **Auth stays ON (default).** See "Embedded auth" below — sessions and OAuth
    state move to stateless cookies, no server store. API tokens already live in
    Neo4j, so they need no change.
  - Connector run store: move from Redis LIST to an in-memory ring buffer or a
    small Neo4j-backed store (`connector-run-store.ts`).
  - Replay stream: gone. Acceptable — replay is currently unused (see
    open-question `replay-stream-wire-or-cut`). The **Neo4j idempotency-checker
    still protects against double-writes**, so losing queue-level dedup is fine.

### Embedded auth (auth ON, no Redis) — decided 2026-06-04

Only two auth pieces are Redis-bound today; both move to stateless cookies in
`embedded` mode. (CORS already does credentialed cross-origin via
`accessControl.web.allowedOrigins`; the signing secret is already required at
≥32 chars.)

- **Sessions → stateless encrypted cookie** (chosen mechanism). The principal
  (id, email, team, roles) is signed/encrypted _into_ the cookie
  (`@fastify/secure-session` or a signed JWT) instead of stored in Redis behind a
  session-ID cookie. Replaces the `@fastify/session` + `RedisSessionStore` pair
  in this mode.
  - Survives process restarts and works across multiple instances / serverless —
    the robustness the Vercel-facing "poke around" deployment needs.
  - **Trade-offs (accepted):** no server-side force-logout of an individual
    session (logout clears the cookie client-side; a denylist would be needed for
    server revocation); keep the payload small; **rotating the signing secret
    invalidates all cookies** (logs everyone out) — so the secret must be a
    stable env var across deploys/instances.
- **OAuth/PKCE state → short-lived signed cookie** set at `/login`, consumed
  single-use at `/callback` (5-min TTL). Replaces `AuthStateStore` (Redis) in
  this mode.
- `distributed` mode keeps `RedisSessionStore` + `AuthStateStore` (server-side
  revocation, larger payloads) — these become a third pair of mode-selected
  seams alongside `ConnectorRunner` / `EventBusClient`.
- **Open: cookie domain topology.** A Vercel web-ui + Fly API split puts the two
  on different registrable domains, making the session cookie a **third-party
  cookie** that Safari/Firefox/Chrome increasingly block — which would silently
  break login regardless of storage mechanism. Two fixes (shared-subdomain custom
  domain vs Vercel same-origin proxy) are tracked in open-question
  `cookie-domain-topology`; **deferred to deployment-setup time** per user
  (2026-06-04).

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
- **Auth (embedded, no Redis):**
  - `packages/api-server/src/server.ts` — select session strategy by `mode`:
    `@fastify/session` + `RedisSessionStore` in `distributed`; stateless
    `@fastify/secure-session` (or signed-JWT cookie) in `embedded`. Keep the
    `request.session` read/write surface consistent across both for route code.
  - `packages/api-server/src/services/auth/` — add a cookie-backed OAuth/PKCE
    state strategy to replace `AuthStateStore` (Redis) in `embedded`.
  - Require the session signing secret as a stable env var in `embedded`
    (fail-fast at boot; rotation logs everyone out).
  - No change to `token-service.ts` (tokens already on Neo4j).
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
- `cookie-domain-topology` — how the Vercel web-ui and Fly API share a first-party
  cookie (shared subdomain vs same-origin proxy). Deferred to deployment-setup
  time; must be resolved before the auth flow works end-to-end on a real deploy.

## Related

- [connector-runner-injection](../patterns/connector-runner-injection.md) — the scheduling seam
- [connector-run-storage-redis-not-yaml](../decisions/connector-run-storage-redis-not-yaml.md) — run store currently in Redis
- [core-writer-runs-as-its-own-process](../decisions/core-writer-runs-as-its-own-process.md) — the process this toggle optionally folds in
- [replay-stream-wire-or-cut](../open-questions/replay-stream-wire-or-cut.md)
- [manual-edit-write-path](../open-questions/manual-edit-write-path.md)
- [cookie-domain-topology](../open-questions/cookie-domain-topology.md)
