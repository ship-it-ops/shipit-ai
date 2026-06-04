---
type: open-question
status: active
created: 2026-06-04
updated: 2026-06-04
author: claude-session-2026-06-04-deployment
opened: 2026-06-04
answer-source: maintainer
tags: [event-bus, replay, redis, cost, yagni]
---

# Should the `shipit-event-log` Redis Stream be wired up or cut?

## Context

The event bus keeps **two** Redis structures, not one:

- the BullMQ work queue `shipit-events` — transient; jobs are published with
  `removeOnComplete: true`, so they vanish once `core-writer` processes them.
- a parallel Redis **Stream** `shipit-event-log` — durable, time-ordered,
  trimmed only by `retentionDays` (default 7). Its sole purpose is to answer
  "re-give me every event since timestamp X," which the queue can't.

`EventBusReplay.replay(fromTimestamp)` (`packages/event-bus/src/bullmq/replay.ts`)
`xrange`s that stream and re-`addBulk`s the envelopes back into the work queue —
the rebuild-without-re-hitting-GitHub path (GitHub is rate-limited to 5k/hr per
installation).

**The problem:** `replay()` is declared on the `EventBusClient` interface
(`packages/shared/src/types/events.ts`) and exercised in tests, but **nothing in
production calls it** — no route, no CLI, no admin button. So today the stream:

- doubles Redis write volume (every `publish` = a queue `addBulk` **plus** a
  stream `xadd` + `xtrim`), worsening the Upstash free-tier command-budget
  problem, and
- pays for a capability not wired to anything.

## Tried

Confirmed via grep that the only references to `replay(` outside the
implementation and tests are the interface declaration. No production caller.

## Decision needed

- **Cut it** (recommended near-term): drop the `xadd`/`xtrim` from the producer,
  halve Redis writes. The Neo4j idempotency-checker still prevents double-writes.
  Rebuild-from-scratch is not a near-term concern (user confirmed, early phase).
- **Or wire it**: add an admin `/replay` route/CLI and keep the stream, if
  rebuild-without-GitHub is a real requirement.

The user said full graph rebuild is **not a concern in this early phase**, which
leans toward "cut" — but the producer change should be made deliberately, not
left as dead weight. In `embedded` deployment mode the stream is dropped for free
(no Redis at all).

## Who Can Answer

Maintainer (user) — product call on whether replay/rebuild is on the roadmap.

## Related

- [deployment-runtime-modes](../plans/deployment-runtime-modes.md) — `embedded` mode drops Redis (and thus the stream) entirely
