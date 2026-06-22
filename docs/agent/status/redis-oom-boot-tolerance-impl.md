---
type: status
status: active
created: 2026-06-22
updated: 2026-06-22
author: claude-session-2026-06-22-redis-oom
branch: main
agent: claude-session-2026-06-22-redis-oom
tags: [redis, oom, bullmq, crashloop, boot, api-server, deploy-blocker]
---

# Tolerate a full/OOM Redis at boot so api-server stops crashlooping

Implements ask #1 of the infra cross-repo brief (deploy of sha-a45d7a4 / #76
rolled back: only api-server crashlooped on `OOM command not allowed` from a
BullMQ `moveToActive` Lua eval). Ask #2 (bound BullMQ retention) is ALREADY
DONE — verified `COMPLETED_JOB_RETENTION`/`FAILED_JOB_RETENTION` set on every
queue (sync-scheduler, webhook-refetch, event-bus producer + replay) by #75.

## Root cause (confirmed in code)

No `.on('error', …)` listener exists on ANY BullMQ Worker/Queue or owned ioredis
client. When Redis is at `maxmemory` (noeviction), the Worker run loop's
`moveToActive` write fails; the Worker emits `'error'` with no listener →
Node throws → process crash → crashloop → helm `--wait` timeout → rollback.
Second vector: `connectorRegistry.startRunner()` (index.ts:386) awaits
`queue.add(repeat)`; on OOM it rejects and bubbles out of `main()` (called with
no `.catch`) → unhandledRejection → crash.

## Scope (boot moveToActive vectors are sync + webhook workers; event-bus

consumer is NOT started in api-server — core-writer subscribes separately)

- `services/sync-scheduler.ts` — queue+worker `'error'` handlers
- `services/webhook-refetch-queue.ts` — queue+worker+dedup-redis `'error'`
- `event-bus/bullmq/producer.ts` — queue+streamRedis `'error'`
- `event-bus/bullmq/consumer.ts` — worker `'error'` (in subscribe)
- `event-bus/bullmq/replay.ts` — queue+redis `'error'`
- `services/connector-registry.ts` — `startRunner()` per-connector try/catch (degrade, keep booting)
- `index.ts` — `runStoreRedis` `'error'` + defensive try/catch around startRunner

Net: with Redis at/over maxmemory, api-server boots, serves `/api/health` 200,
logs that syncs are degraded — no crash.

## Status

MERGED to main as PR #85 (squash `3c25e8a`, 2026-06-22). Stops the crash. Note
the FOLLOW-UP: the live Redis is still full — `--bigkeys` showed the real
dominant key is the `shipit-event-log` stream (~825 MB), addressed separately in
[event-log-stream-bound-impl](event-log-stream-bound-impl.md). This entry can be
archived once the demo redeploys and is confirmed healthy.

Done:

- `'error'` listeners on every boot-time emitter: sync-scheduler queue+worker;
  webhook-refetch queue+worker+dedup-redis; event-bus producer queue+streamRedis,
  consumer worker, replay queue+redis; index.ts runStoreRedis. Each logs +
  degrades, never rethrows.
- `connector-registry.startRunner()` now catches per-connector so an OOM
  enqueue degrades that connector instead of bubbling to an unhandledRejection;
  index.ts also wraps the `startRunner()` call defensively.
- Tests (TDD, red→green): sync-scheduler + webhook-refetch-queue (listener
  present + handler swallows OOM), event-bus producer/consumer/replay (same),
  connector-registry (startRunner resolves + attempts all connectors + warns
  when a runner.start rejects).

Verified: `pnpm -r typecheck` clean; `pnpm -r test` all green (api-server 397,
event-bus 25, every other package unchanged-green); prettier clean on touched
files; `pnpm build` clean for both packages (deploy runs `node dist/index.js`).

Ask #2 (retention) confirmed ALREADY shipped (#75) on all four queues — no
change needed.

Remaining (infra/ops, not code): boot `node dist/index.js` against a Redis at
`--maxmemory` to confirm /api/health stays 200 under live OOM (covered
mechanically by the unit tests; this is the deploy-time smoke).

## Related

- [redis-memory-limit-below-dataset-oomkills](../scars/redis-memory-limit-below-dataset-oomkills.md)
- [redis-dataset-unbounded-growth](../open-questions/redis-dataset-unbounded-growth.md) (ask #2, already resolved #75)
- [bullmq-5-forbids-colons-in-queue-names-and-job-ids](../scars/bullmq-5-forbids-colons-in-queue-names-and-job-ids.md)
