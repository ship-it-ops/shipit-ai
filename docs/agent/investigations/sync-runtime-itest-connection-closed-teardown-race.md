---
type: investigation
status: active
created: 2026-09-15
updated: 2026-09-25
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

## Second sighting, 2026-09-25 (PR #115) — the fix CHANGED THE SYMPTOM

Same test, new signature. `stands up the live scheduler against real Redis and routes a sync to
it` **failed outright with `Test timed out in 5000ms`** (run 36089676481, job 107931421330) —
not the old "all tests pass, job red on an unhandled rejection".

That is the awaiting-job-settle fix working as designed and then losing the race: the test now
waits for the job's terminal state instead of tearing down underneath it, so when the worker
does not pick the job up in time the wait hits vitest's 5s default rather than leaking a
rejection. The old symptom is gone; this is what remains.

Re-running the failed job on the identical commit passed (job 107932436504), and the next push
passed again. Unrelated to that PR's diff, which touched no Redis/BullMQ path.

**This resets the green-run count.** The ~20-run bar below was written against the
unhandled-rejection signature; timeouts are a different failure mode and the counter should be
tracked against THIS one from 2026-09-25 onward.

If it keeps recurring, the fix is a longer explicit timeout on that single test (the settle wait
is doing real work against a cold CI Redis, and 5s is vitest's default, not a considered budget)
— not reverting the await.

## Prevention

- If `Integration (Neo4j)` is red and the culprit is `sync-runtime.integration.test.ts` — in
  EITHER form: all-tests-pass-plus-unhandled-rejection (pre-2026-09-15), or that one test
  timing out at 5000ms (post-fix) — it is this race. Re-run the job
  (`gh run rerun --job <job-id>`) rather than bisecting the diff. Two independent commits have
  now passed on re-run with no change.
- Any new BullMQ integration test that enqueues work must await the job's terminal state
  before closing the worker.

## Related

- [integration-tests-sharing-a-db-must-run-serially](../scars/integration-tests-sharing-a-db-must-run-serially.md)
  — the other "green alone, red in CI" integration-test trap
- [apiserver-crashloop-unhandled-bullmq-error-on-oom-redis](apiserver-crashloop-unhandled-bullmq-error-on-oom-redis.md)
  — where the handled `worker.on('error')` warning line comes from
- [bullmq-5-forbids-colons-in-queue-names-and-job-ids](../scars/bullmq-5-forbids-colons-in-queue-names-and-job-ids.md)
  — what this test exists to guard
