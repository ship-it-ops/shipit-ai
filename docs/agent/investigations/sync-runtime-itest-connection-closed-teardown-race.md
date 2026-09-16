---
type: investigation
status: active
created: 2026-09-15
updated: 2026-09-15
author: claude-fable-5-1-session-01Au4gDpcAj93LDvrEzXqLsE
tags: [ci, integration-tests, bullmq, ioredis, flaky, api-server]
importance: standard
---

# CI `Integration (Neo4j)` goes red with 47/47 passing: unhandled `Connection is closed.` from the sync-runtime test's teardown

## Symptoms

- The `Integration (Neo4j)` CI job fails while every test passes
  (`Test Files 8 passed | 2 skipped`, `Tests 47 passed | 8 skipped`, `Errors 1 error`).
- Vitest reports **1 unhandled rejection**: `Error: Connection is closed.` at
  `ioredis@5.10.1/built/redis/event_handler.js:214` (the `close` handler that rejects every
  still-pending command), "originated in `src/__tests__/services/sync-runtime.integration.test.ts`".
- A stderr line right before it: `SyncScheduler worker Redis error (syncs degraded, API stays
up): Connection is closed.` — that one IS handled (`sync-scheduler.ts` `worker.on('error')`);
  a second, separate promise is the one that goes unhandled.
- Seen once on PR #108 at `cfa12d5` (run 35009475977). **Re-running the failed job on the
  identical commit passed** (job 104519493111). Nothing in the Redis path changed in that
  commit (ioredis 5.10.1/5.11.1 and bullmq 5.79.1 untouched; the bumps were next, fastify,
  hono, qs, js-yaml, fast-uri, browserslist — none used by this test).

## Root Cause

**Timing-dependent teardown race, not a regression.** Mechanism (plausible, not yet proven —
no local Redis/Docker on the machine that investigated; the only evidence is CI):

1. Test 1 (`stands up the live scheduler…`) calls `registry.triggerSync()`, which is just
   `queue.add('manual:github-acme', …)` — it resolves as soon as the job is enqueued and the
   test ends **without waiting for the worker to pick the job up or finish it**.
2. `afterEach` immediately runs `scheduler.close()` → `worker.close()` → `queue.close()`,
   then closes the webhook queue and the event bus.
3. Depending on scheduling, the worker (concurrency 1) is mid-`moveToActive`/blocking fetch
   or mid-`processJob` (which hits the "No GitHub App configured" branch, awaits
   `registry.recordRun` to disk, then BullMQ moves the job to completed) when its ioredis
   connections are closed. ioredis rejects the in-flight command with `Connection is
closed.`; one of those rejections has no handler attached → vitest's unhandled-error
   collector marks the run failed.

Most of the time the job completes (or hasn't started) before close, so it passes.

## Fix

Applied 2026-09-15 (post-round-6 housekeeping PR), test-side only: test 1 now polls
`registry.getStatus(CONNECTOR.id).state` until it leaves `'running'` before the test ends,
then asserts the terminal `'failed'` + `lastError` ("No GitHub App configured") — so
`afterEach` never closes the worker mid-job, and the test additionally proves the live
worker really processed the job (the old `'running'`-only assertions couldn't). The
immediate `getStatus` check after `triggerSync` was relaxed from `'running'` to
`not 'idle'` because a fast worker can settle the job before that line runs (a second,
latent flake in the old form). Do NOT reach for `worker.close(true)` (force) — that aborts
the active job and would make the race _more_ likely to surface.

Kept `status: active` (not `fixed`) on purpose: the mechanism is inferred from CI evidence,
not reproduced. Every BullMQ/ioredis emitter on this path DOES have an `'error'` listener
(scheduler, webhook queue, event-bus producer/replay/consumer), so the unhandled promise is
something internal to bullmq's close sequence, not a missing listener. Flip to `fixed` after
~20 green `Integration (Neo4j)` runs without the signature; reopen here if it recurs.

## Prevention

- If `Integration (Neo4j)` is red but the summary shows all tests passed and the only
  error is this unhandled rejection from `sync-runtime.integration.test.ts`, it is this
  race — re-run the job (`gh run rerun <run-id> --failed`) rather than bisecting the diff.
- Any new BullMQ integration test that enqueues work must await the job's terminal state
  before closing the worker.

## Related

- [integration-tests-sharing-a-db-must-run-serially](../scars/integration-tests-sharing-a-db-must-run-serially.md)
  — the other "green alone, red in CI" integration-test trap
- [apiserver-crashloop-unhandled-bullmq-error-on-oom-redis](apiserver-crashloop-unhandled-bullmq-error-on-oom-redis.md)
  — where the handled `worker.on('error')` warning line comes from
- [bullmq-5-forbids-colons-in-queue-names-and-job-ids](../scars/bullmq-5-forbids-colons-in-queue-names-and-job-ids.md)
  — what this test exists to guard
