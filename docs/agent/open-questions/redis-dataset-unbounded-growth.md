---
type: open-question
status: answered
opened: 2026-06-17
updated: 2026-06-22
answer-source: experiment
importance: standard
tags: [redis, bullmq, queue-retention, memory, event-log-stream]
---

# Why has the portal-demo redis dataset grown to ~246 MB, and how do we bound it?

> **ANSWERED & RESOLVED** — but the 2026-06-18 answer below NAMED THE WRONG
> DOMINANT SOURCE. **Correction (2026-06-22, from `redis-cli --bigkeys`):** the
> dataset is almost entirely ONE key — the `shipit-event-log` Redis **Stream** at
> **~825 MB**. The BullMQ completed/failed job keys that #75 bounded are
> negligible (~0.1 MB), so #75 + flushing BullMQ keys frees essentially nothing
> and leaves Redis full. `shipit-event-log` is an **application** key (the
> replay-only audit stream, source #3 below — which the original triage flagged
> but mis-ranked as minor), NOT a BullMQ key. The real fix is to stop writing
> that stream (it's replay-only and `replay()` is never called): the producer now
> gates it behind `eventLogEnabled` (default false) + a `MAXLEN ~` ceiling when
> on — see [replay-stream-wire-or-cut](replay-stream-wire-or-cut.md), now
> RESOLVED, branch `fix/event-log-stream-bound`. The live ~825 MB key needs a
> one-time `DEL shipit-event-log` / `XTRIM` to reclaim; code only stops growth.
>
> ---
>
> _Original (superseded) 2026-06-18 answer:_ "Root cause was unbounded BullMQ
> completed/failed job retention (sync-scheduler queue + `removeOnFail: false` in
> the event-bus producer/replay). App-side retention bounds shipped in #75…" —
> #75 was real and worth keeping (it bounds the BullMQ keys), but it was NOT the
> dataset's dominant share. The `--bigkeys` verify step it deferred is exactly
> what surfaced the stream as the true culprit.

## Context

The 2026-06-17 redis OOM outage was triggered by the dataset (~246 MB, 231
keys) exceeding the 256Mi container limit. Raising the limit (infra brief) is
the immediate fix, but a stateful cache/queue that grows unbounded will just
outgrow the next limit too. 246 MB across only 231 keys means large values —
consistent with **BullMQ retaining completed/failed job payloads**.

## Root sources identified (2026-06-17, from code)

Three compounding, **unbounded** redis-growth sources — none of which trim:

1. **sync-scheduler queue (likely dominant)** —
   `packages/api-server/src/services/sync-scheduler.ts:125` adds a
   **repeatable cron job per connector** (`{ repeat: { pattern:
connector.schedule } }`) with **no `removeOnComplete` / `removeOnFail`**.
   Every cron tick leaves a retained completed (and failed) job hash. Growth
   = sync frequency × uptime × connectors. The `manual:` adds (line 152)
   are likewise unbounded.
2. **event-bus producer queue** —
   `packages/event-bus/src/bullmq/producer.ts:94-95` sets `removeOnComplete:
true` (good) but **`removeOnFail: false`** — every failed event job is
   kept forever, _with the full canonical entity as `data` payload_. Same in
   `replay.ts:48-49`.
3. **event-bus Redis Stream `shipit-event-log`** — `producer.ts:107` XADDs
   full event JSON; trimmed to `retentionDays` (default **7**,
   `config.ts:23`). Bounded at 7d but pure dead weight: `replay()` is never
   consumed (see [replay-stream-wire-or-cut](replay-stream-wire-or-cut.md)).

## Fix (app-owned)

- sync-scheduler: add `defaultJobOptions: { removeOnComplete: <count/age>,
removeOnFail: <count/age> }` to the `new Queue(...)` (and on the repeatable
  add). This is the highest-leverage change.
- event-bus producer/replay: change `removeOnFail: false` → a bounded count
  or age (e.g. `{ age: 7*24*3600, count: 1000 }`). Keep failures long enough
  to debug, not forever.
- Decide replay stream's fate (cut it, or shorten retention) per the linked
  open-question.

## Verify

After landing, inspect with `redis-cli --bigkeys` / `MEMORY USAGE` via a
temporary port-forward to confirm the working set is bounded and flat.
