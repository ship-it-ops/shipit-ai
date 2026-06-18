---
type: scar
status: active
incident-date: 2026-06-17
importance: core
tripwire: "portal-demo shows 'data gone / no connectors' but app+LB are healthy → check `kubectl get pods -n shipit` for redis-0 OOMKilled FIRST"
tags: [redis, oom, crashloop, outage, portal-demo, bullmq]
---

# "Data gone" on portal-demo can be redis OOMKilled, not data loss

## What Happened

2026-06-17: user reported portal-demo "all data gone, connectors not showing
up." App + LB were fully healthy (`/api/health` 200, `/` → `/login`). The
real cause: `redis-0` was **OOMKilled crashlooping** (24 restarts) because
its dataset (~246 MB) exceeded the container memory **limit (256Mi)**. redis
0/1 → headless Service had no endpoints → DNS NXDOMAIN → api-server ioredis
`ENOTFOUND` → BullMQ/cache dead → UI looked empty. No data was actually lost
(graph is external Neo4j Aura; redis AOF intact on PVC).

## Tripwire

If portal-demo shows "data gone / no connectors" **but the app and LB are
healthy** (`/api/health` 200, `/` redirects to `/login` not `/setup`), run
`kubectl get pods -n shipit` and look for **`redis-0` OOMKilled /
CrashLoopBackOff** BEFORE suspecting data loss or a graph wipe.

## Why It Hurt

A redis crashloop presents identically to catastrophic data loss from the
user's seat — empty dashboard, no connectors — which invites panic and
wrong fixes (restoring backups, re-syncing connectors) when the data is fine
and the actual fix is a one-line memory-limit bump.

## Don't Do This

- Don't assume "empty UI" = data loss. Check pod health first.
- Don't ship a `noeviction` redis **without an explicit `--maxmemory` below
  the k8s memory limit** — without it, "fail writes loud" silently becomes a
  kernel OOMKill crashloop (full outage), the opposite of the intent.
- Don't set a stateful cache's memory limit at or below its working set.

## Related

- [investigation: redis-oom-crashloop-data-appears-gone](../investigations/redis-oom-crashloop-data-appears-gone.md)
- [open-question: redis-dataset-unbounded-growth](../open-questions/redis-dataset-unbounded-growth.md)
