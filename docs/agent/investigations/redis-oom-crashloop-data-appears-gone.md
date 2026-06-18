---
type: investigation
status: completed
importance: core
created: 2026-06-17
updated: 2026-06-17
author: claude-session-2026-06-17
branch: main
tags: [redis, oom, crashloop, outage, portal-demo, bullmq, infra]
---

# portal-demo "all data gone / connectors missing" — redis OOMKilled crashloop

## Symptoms

User reported portal-demo.shipitops.com showed **"all data gone, nothing
loading, connectors not showing up"** on 2026-06-17. The app itself looked
up (login worked).

## Investigation path (what ruled out the prior scars)

- HTTP probes: `/api/health` 200, `/login` 200, `/` → 307 `/login`.
  - 200 on `/api/health` ⇒ **NOT** the NEG-drain total-502 scar (that 502s
    every path at the LB).
  - `/` → `/login` (not `/setup`) ⇒ **NOT** setup-mode re-entry; the
    `shipit-setup-completed` latch is intact.
- `kubectl get pods -n shipit`: every pod 1/1 **except `redis-0`**, which
  was `0/1 CrashLoopBackOff`, 24 restarts. (No Neo4j pod — graph is external
  Aura.)

## Root cause

`redis-0` was **OOMKilled** (`Last State: Terminated, Reason: OOMKilled,
Exit Code: 137`). The container memory **limit is 256Mi**, but the dataset
had grown to **~246 MB** (boot log: `RDB memory usage when created 246.54
Mb`, `keys loaded: 231`). On each start redis loads the full dataset, reaches
`Ready to accept connections`, crosses 256Mi within ~16s, and the kernel
kills it → CrashLoopBackOff. **No `--maxmemory` is set** (args: `--appendonly
yes --maxmemory-policy noeviction`), so redis grows unbounded until it hits
the k8s limit.

### Impact chain

redis-0 never Ready (0/1) → headless Service `redis` has no endpoints → DNS
`redis.shipit.svc.cluster.local` returns **NXDOMAIN** → api-server ioredis
floods `getaddrinfo ENOTFOUND redis.shipit.svc.cluster.local` → BullMQ queues

- redis-backed reads fail → UI renders no connectors / no data.

### Data was NOT lost

Graph data is in **Neo4j Aura** (external), untouched. redis's own AOF is
intact on its PVC and loads cleanly every boot (`keys loaded: 231`). The
"data gone" was purely a **redis-unreachable display symptom**.

## Fix

Infra-owned (the limit lives in `charts/shipit-ai/values.yaml` `redis:`
block; demo inherits it — `values.demo.yaml` has no override). Requested via
cross-repo brief: raise limit 256Mi → 1Gi (request 512Mi) **and** add a
`--maxmemory` guard below the k8s limit so `noeviction` fails writes loud
instead of OOMKilling. Per operator instruction, **no live `kubectl` patch
was applied** — durable Helm fix only.

Brief: `shipit-ai-infra/docs/agent/plans/cross-repo-prompt-redis-oom-memory-limit.md`.

## Prevention

- Container memory limits for a stateful cache MUST exceed the working set
  plus AOF-rewrite/CoW headroom — and a `noeviction` redis needs an explicit
  `--maxmemory` below the k8s limit or the "fail loud" intent silently
  becomes an OOMKill crashloop.
- App-side: bound BullMQ job retention so the dataset stops growing. Tracked
  in [redis-dataset-unbounded-growth](../open-questions/redis-dataset-unbounded-growth.md).

## Related

- [scar: redis-memory-limit-below-dataset-oomkills](../scars/redis-memory-limit-below-dataset-oomkills.md)
- [open-question: redis-dataset-unbounded-growth](../open-questions/redis-dataset-unbounded-growth.md)
- [portal-demo-502-node-recreation-neg-drain](portal-demo-502-node-recreation-neg-drain.md) — the _other_ total-outage shape, ruled out here
