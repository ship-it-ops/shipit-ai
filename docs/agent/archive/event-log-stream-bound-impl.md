---
type: status
status: completed
created: 2026-06-22
updated: 2026-06-22
author: claude-session-2026-06-22-redis-oom
branch: fix/event-log-stream-bound
agent: claude-session-2026-06-22-redis-oom
tags: [redis, oom, event-bus, event-log-stream, replay, memory]
---

# Cut/bound the `shipit-event-log` Redis Stream — the real ~825 MB OOM culprit

Follow-up to PR #85 (boot OOM tolerance, merged 3c25e8a). `redis-cli --bigkeys`
on the live demo showed the 768mb dataset is almost entirely ONE app key:
`shipit-event-log` (the replay-only event-bus Redis Stream) at **~825 MB**.
BullMQ completed/failed keys are ~0.1 MB, so #75's retention bounds + a BullMQ
flush free essentially nothing. The original
[redis-dataset-unbounded-growth](../open-questions/redis-dataset-unbounded-growth.md)
answer named the wrong dominant source; corrected.

## Change

- `event-bus/config.ts`: add `eventLogEnabled` (default **false**) +
  `eventLogMaxLen` (default 10_000) to EventBusConfig/ResolvedConfig/defaults.
- `event-bus/bullmq/producer.ts`: only `XADD shipit-event-log` when
  `eventLogEnabled`; when on, `XADD … MAXLEN ~ eventLogMaxLen` (hard size
  ceiling) plus the existing MINID time trim. Normal BullMQ delivery
  (`addBulk` → consumer) is untouched.
- api-server passes only `{ redisUrl }` → default false → stream is cut in prod.
  `replay()` is still never called anywhere (verified), so cutting the write is
  safe; reversible via config, nothing deleted.

## Why this shape (not hard-delete, not cap-only)

`replay()` is dead in prod but the open question only _leaned_ cut. A
default-off flag + MAXLEN gives the cut now, keeps it reversible, and bounds it
if ever revived — resolves [replay-stream-wire-or-cut](../open-questions/replay-stream-wire-or-cut.md).

## Verify

`pnpm -r typecheck` clean; `pnpm -r test` all green (event-bus 26, all other
packages unchanged); prettier + `pnpm build` clean. New tests: default config is
disabled; enabled path emits `MAXLEN ~`; disabled path skips the stream but
still delivers.

## Status

PR #86 open. Review (ship-reviewed-prs bot) = LGTM; one nit fixed:
**IN7-RESOURCE** — `streamRedis` was opened unconditionally, so with the flag
off (prod default) the producer held an idle, never-used Redis connection
(ironic for a PR about cutting Redis pressure). Now created lazily only when
`eventLogEnabled` (`Redis | null`), with `publish()` gated on its presence and
`close()` null-guarded. Tests assert NO stream connection is opened when
disabled and exactly one when enabled. All green.

## Ops follow-up (not code)

The live ~825 MB `shipit-event-log` won't shrink on its own — this only stops
growth. Infra one-time reclaim: `DEL shipit-event-log` (safe: replay unused) or
`XTRIM shipit-event-log MINID <recent>`. A BullMQ flush is the WRONG target.

## Related

- [apiserver-crashloop-unhandled-bullmq-error-on-oom-redis](../investigations/apiserver-crashloop-unhandled-bullmq-error-on-oom-redis.md) — PR #85, stop the crash
- [redis-dataset-unbounded-growth](../open-questions/redis-dataset-unbounded-growth.md) — corrected dominant source
- [replay-stream-wire-or-cut](../open-questions/replay-stream-wire-or-cut.md) — resolved by this
- [redis-memory-limit-below-dataset-oomkills](../scars/redis-memory-limit-below-dataset-oomkills.md)
