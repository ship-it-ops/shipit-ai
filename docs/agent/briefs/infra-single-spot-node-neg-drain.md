# Infra brief — eliminate full-outage 502s from single Spot node + NEG drain

**For:** `Ship-It-Ops/shipit-ai-infra` (Terraform: GKE node pool + k8s
PodDisruptionBudgets / Helm chart).
**From:** app repo, 2026-06-15. **Severity:** core — recurring full demo
outage.
**Context:** `docs/agent/investigations/portal-demo-502-node-recreation-neg-drain.md`.

## What happened (2026-06-15 ~20:00 UTC)

`portal-demo.shipitops.com` returned **502 on every path, including
`/api/health`**, for several minutes. Not an app bug: the GCP LB had
**zero NEG endpoints** to route to. Root cause chain:

1. The cluster's single node was recreated (Spot reclaim / auto-repair).
2. Node pool `shipit-demo-primary` is **`e2-standard-2`, `spot=True`,
   fixed `initialNodeCount=1`, NO autoscaling range** → with the node
   gone there was nowhere to schedule pods (`FailedScheduling: no nodes
available`; `cluster-autoscaler: NotTriggerScaleUp` ×43).
3. All pods unschedulable → container-native LB **NEGs drained to size 0**
   (`web-ui`, `api-server`). LB with no backends → 502 everywhere.
4. There are **no PodDisruptionBudgets** in the `shipit` namespace, so
   nothing constrained the disruption.
5. Self-healed ~8 min later when the node returned, pods rescheduled, and
   `neg-readiness-reflector` re-registered endpoints (NEGs back to 1).

This is the recurring "NEG churn" prior sessions noted. On a single Spot
node it is structural: **every preemption = a multi-minute hard-502
outage.**

## Observed cluster facts (for reference)

- Cluster `shipit-demo`, zonal `us-central1-a`, project `ship-it-ai-portal`.
- Node pool `shipit-demo-primary`: `e2-standard-2`, `spot=True`, 1 node,
  no `autoscaling.min/maxNodeCount`.
- `kubectl get pdb -n shipit` → none.

## Requested changes (pick per cost appetite; #1 is the floor)

1. **Remove the single-point-of-failure node.** Either:
   - **(a, cheapest fix)** Keep Spot but set the pool to autoscale with
     `minNodeCount>=2` across `e2-standard-2` so a single reclaim never
     leaves zero schedulable nodes; OR
   - **(b, most robust)** Add a small **on-demand** pool (1× `e2-small`/
     `e2-medium`) alongside the Spot pool so core pods always have a
     non-preemptible home, with Spot for burst.
     Multi-zone (regional) node pool is a further hardening but (a)/(b)
     already remove the full-blackout failure mode.
2. **Add PodDisruptionBudgets** for `api-server` and `web-ui`
   (`minAvailable: 1`) so a drain/preemption can't take the last replica.
   Pairs with running **2 replicas** of api-server and web-ui (currently
   1 each) — without a 2nd replica a PDB just blocks the drain.
3. **(Optional) Shrink the 502 window during legitimate node churn.**
   Faster readiness re-registration: confirm the BackendConfig health
   check path/interval is tight, and consider
   `cloud.google.com/load-balancer-neg-ready` readiness-gate tuning so
   endpoints re-add promptly.

## Notes / safety

- **No app-side change is required or blocked by this** — the app pods
  are healthy; this is purely scheduling + LB resilience.
- The demo is currently UP (verified 200 on `/api/health` and `/login`
  post-recovery). This brief is to prevent the _next_ preemption from
  repeating the outage, not an active incident.
- Cost note: option (a) doubles Spot node cost (still cheap); option (b)
  adds one small on-demand VM. Either is small for a demo and removes a
  recurring "site is down" surprise.
