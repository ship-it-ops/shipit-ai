---
type: investigation
status: fixed
created: 2026-06-22
updated: 2026-06-22
author: claude-session-2026-06-22-redis-oom
importance: core
tags: [redis, oom, bullmq, ioredis, crashloop, boot, api-server, deploy-blocker]
---

# api-server crashlooped at boot on a full Redis — unhandled BullMQ/ioredis 'error' event

## Symptoms

Deploy of `sha-a45d7a4` (#76) timed out and rolled back. ONLY api-server
crashlooped; the other three workloads rolled out fine. Boot log:

```
ERROR ReplyError: OOM command not allowed when used memory > 'maxmemory'.
  script: ... @user_script:215      (BullMQ moveToActive Lua eval)
```

Redis had been up 4.5 days and its BullMQ dataset grew into the intentional
`--maxmemory 768mb --maxmemory-policy noeviction` ceiling, so it rejected
writes.

## Root Cause

NO `.on('error', …)` listener existed on ANY BullMQ `Worker`/`Queue` or owned
`ioredis` client in the api-server / event-bus boot path. A BullMQ
Worker/Queue and an ioredis client are all `EventEmitter`s, and **an emitted
`'error'` with no listener is rethrown by Node as an uncaughtException and
kills the process.**

Two concrete boot-time vectors against an at-`maxmemory` Redis:

1. **Worker run loop (the one in the stack trace).** Each Worker
   (sync-scheduler, webhook-refetch) starts its run loop at construction
   (`autorun` default) and calls `moveToActive` — a Lua eval that WRITES.
   Against a full Redis it fails with the OOM `ReplyError`; the Worker emits
   `'error'`; no listener → crash. This is why the error surfaced AFTER
   "WebhookRefetchQueue attached" (i.e. after `wireSyncRuntime`'s synchronous
   construction succeeded) — it came from an async queue op, not the ctor.
2. **Boot enqueue.** `connectorRegistry.startRunner()` (index.ts) awaits
   `scheduler.start()` → `queue.add(repeat)` (a write). On OOM it rejects;
   the rejection bubbles out of the un-`.catch()`ed `main()` →
   unhandledRejection → crash.

`wireSyncRuntime`'s existing try/catch only guards SYNCHRONOUS construction
throws (the colon-in-queue-name scar), so neither async vector was covered.

## Fix

App-side (per operator decision: hold infra at 768mb, fix in the app):

1. Attach a logging `'error'` listener to every boot-time emitter so an OOM /
   connection error DEGRADES instead of crashing: sync-scheduler queue+worker;
   webhook-refetch queue+worker+dedup-redis; event-bus producer queue+streamRedis,
   consumer worker, replay queue+redis; index.ts `runStoreRedis`.
2. Make `ConnectorRegistry.startRunner()` catch per-connector (degrade that
   connector's scheduling, keep booting); index.ts also wraps the call
   defensively.

Net: with Redis at/over `maxmemory`, api-server boots, serves `/api/health`
200, and logs that syncs are degraded — no crash. Once the dataset drains
(ask #2 retention bounds from #75 + job completion) writes recover and the
next poll tick reschedules.

Ask #2 (bound BullMQ retention) was ALREADY shipped in #75 on all four queues
(`COMPLETED_JOB_RETENTION`/`FAILED_JOB_RETENTION`) — verified, no change.

## Prevention

Reusable rule — **every BullMQ `Queue`/`Worker` and every `ioredis` client you
construct MUST get an `.on('error', …)` listener**, or a transient Redis error
(OOM, connection drop, failover) becomes a process-killing uncaughtException.
A synchronous-only try/catch around construction does NOT cover the async
run-loop / write paths. Tests pin a registered `'error'` listener on each
emitter and assert the handler swallows an OOM `ReplyError` without rethrowing.

## Related

- [redis-memory-limit-below-dataset-oomkills](../scars/redis-memory-limit-below-dataset-oomkills.md) — sibling infra-side scar (2026-06-17)
- [redis-oom-crashloop-data-appears-gone](redis-oom-crashloop-data-appears-gone.md) — the 2026-06-17 investigation
- [redis-dataset-unbounded-growth](../open-questions/redis-dataset-unbounded-growth.md) — ask #2, resolved in #75
- [bullmq-5-forbids-colons-in-queue-names-and-job-ids](../scars/bullmq-5-forbids-colons-in-queue-names-and-job-ids.md) — the OTHER (synchronous) BullMQ boot footgun
