---
type: status
status: completed
created: 2026-06-17
updated: 2026-06-17
author: claude-session-2026-06-17
branch: main
agent: claude-session-2026-06-17
tags: [redis, bullmq, retention, oom, event-bus, sync-scheduler]
---

# Bounded BullMQ job retention — implemented, uncommitted

> **SHIPPED & DEPLOYED** (#75, 2026-06). Archived.

## Scope

Fixes the unbounded Redis growth behind the 2026-06-17 OOM incident
(plan: `~/.claude/plans/alright-go-ahead-and-spicy-pudding.md`).

- `packages/event-bus/src/bullmq/retention.ts` (new) — `FAILED_JOB_RETENTION`
  (7d/5k), `COMPLETED_JOB_RETENTION` (24h/1k); exported via package index.
- `producer.ts` + `replay.ts` — `defaultJobOptions: { removeOnComplete: true,
removeOnFail: FAILED_JOB_RETENTION }`; per-job opts now carry only `jobId`
  (the old `removeOnFail: false` was the main leak).
- `sync-scheduler.ts` — `defaultJobOptions: { removeOnComplete:
COMPLETED_JOB_RETENTION, removeOnFail: FAILED_JOB_RETENTION }` on its Queue
  (covers repeatable `poll:` + one-shot `manual:` adds).
- `packages/api-server/scripts/clean-queues.ts` (new) — one-time backlog purge
  via `queue.clean()` for the live demo (run post-deploy).
- Tests: extended `event-bus.test.ts` (+2, Queue-construction asserts);
  new `sync-scheduler.test.ts` (first BullMQ-mock test in api-server).

## Why

Redis crept to ~246MB and OOMKilled because no queue trimmed completed/failed
jobs. See [redis-oom-crashloop-data-appears-gone](../investigations/redis-oom-crashloop-data-appears-gone.md)
and [redis-dataset-unbounded-growth](../open-questions/redis-dataset-unbounded-growth.md).

## Verified

`pnpm -r typecheck` EXIT 0; `pnpm -r test` EXIT 0 (event-bus 22, api-server 307
incl. new sync-scheduler 2, all other packages green). Cleanup script
typechecks standalone. NOTE: api-server typechecks against event-bus's `dist`,
so `pnpm --filter @shipit-ai/event-bus build` must run before api-server
typecheck sees the new exports.

## Blocked on

User approval to commit / open PR (standing instruction: never commit/push
without explicit approval). Rollout (deploy + run `clean-queues.ts` against the
live demo) also pending approval; depends on infra's 1Gi+maxmemory redis change
being deployed too.
