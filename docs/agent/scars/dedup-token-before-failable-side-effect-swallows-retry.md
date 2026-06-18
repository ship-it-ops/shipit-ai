---
type: scar
status: active
created: 2026-06-18
updated: 2026-06-18
author: claude-session-2026-06-18-webhook-exec
incident-date: 2026-06-18
tripwire: 'if you set a dedup/idempotency token BEFORE a side-effecting step that can fail-and-be-retried, release the token on the failure path — or the retry gets deduped and silently lost'
tags: [webhooks, idempotency, dedup, redis, bullmq, retry, ordering]
importance: core
---

# Dedup-before-a-failable-side-effect swallows the retry

## What Happened

The GitHub webhook receiver (Cut A) marked each delivery seen
(`markDeliverySeen`, a Redis `SET … NX EX 600`) **before** enqueuing the refetch
job. The receiver's durability contract is "transient failure → return 5xx so
GitHub redelivers; polling is the backstop." But because the dedup key was set
first, the sequence `mark-seen ✓ → enqueue ✗ → 500` left the key in place; GitHub's
redelivery (seconds later, well inside the 600s TTL) hit the dedup check, got a
`202 duplicate_delivery`, and **never re-enqueued** — the refetch was permanently
lost, recoverable only by the unrelated polling sweep. The two contracts
(dedup-before-refetch and 5xx-means-recoverable) silently contradicted each other.

Caught by the ship-better-plans multi-persona audit (adversarial persona,
high-confidence refute-survival), not by tests — the existing "enqueue → 500" test
asserted the 500 but never re-sent the delivery, so the swallow was uncovered.

Reachable modes: memory crossing the Redis noeviction `maxmemory` threshold
_between_ the two ops (the exact 2026-06-17 OOM config — see
[redis-memory-limit-below-dataset-oomkills](redis-memory-limit-below-dataset-oomkills.md)),
or a failure isolated to BullMQ's pooled connection while the separate dedup
ioredis client still succeeds.

## Tripwire

Setting a dedup/idempotency token _before_ a side-effecting step that can
fail-and-retry. Ask: "if the step after the token-set fails and the caller
retries, will the token make the retry a no-op?" If yes, you have this bug.

## Why It Hurt

Silent data loss with no error surfaced (the 202 looks healthy). The receiver
appeared to work; deliveries were dropped only in the narrow fail-after-mark
window, making it near-impossible to spot in the field.

## Don't Do This

- Don't set a dedup token before a failable side effect without a compensating
  release on the failure path.
- Options, cleanest first: (a) **release the token on the failure path** (what we
  did — `releaseDelivery` DELs the key in the catch); (b) commit the token only
  _after_ the side effect succeeds (loses SETNX atomicity for concurrent dupes);
  (c) make the side effect idempotent and skip dedup entirely.
- When you write the "transient failure → retry" test, **actually re-send** the
  retry and assert it is processed — don't just assert the first attempt's 5xx.

## Related

- [webhook-receiver-design](../decisions/webhook-receiver-design.md)
- [github-webhook-receiver](../plans/github-webhook-receiver.md)
- [redis-memory-limit-below-dataset-oomkills](redis-memory-limit-below-dataset-oomkills.md)
