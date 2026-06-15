---
type: investigation
status: completed
importance: core
created: 2026-06-15
updated: 2026-06-15
author: claude-session-2026-06-15
branch: more-prod-fixes
tags: [infra, gke, neg, load-balancer, 502, outage, portal-demo, spot]
---

# portal-demo full 502 — single-node recreation drained the NEGs

## Symptom

Every path on `portal-demo.shipitops.com` returned **502** — including
`/api/health` — for a multi-minute window on 2026-06-15 ~20:00 UTC
(~3:00 PM CDT). User had used the site fine at ~2:51 PM. Self-recovered
~8 min later (200s returned once pods rescheduled and NEGs repopulated).

## Root cause (NOT an app bug)

The cluster `shipit-demo` is a **single-node zonal** pool in
`us-central1-a`. The node was **recreated** (Spot preemption / auto-repair
suspected). Sequence:

1. Node replaced → pod events show `FailedScheduling: no nodes available
to schedule pods` and `0/1 nodes are available: 1 node(s) had
untolerated taint(s)`. `cluster-autoscaler: NotTriggerScaleUp` ×43 —
   it could not add a node (single pool, no headroom).
2. With no Ready node, every pod was unschedulable. The GKE
   container-native LB **NEGs drained to size 0** (verified:
   `gcloud compute network-endpoint-groups list` → web-ui/api-server
   NEGs both `size 0`).
3. LB had zero backends → 502 on ALL paths (app + `/api/health`),
   because the 502 is emitted at the LB, not the pods.
4. New node came up; pods rescheduled (~2 min before observation);
   `redis-0` reattached its PVC and pulled `redis:7-alpine`; api-server
   ran its `seed-config` init then started serving `/api/health` 200 to
   the `35.191.222.x` Google health-check IPs.
5. `neg-readiness-reflector` re-added pods once healthy → NEGs back to
   `size 1` → external 200. Self-healed.

## Confirmation snapshot (post-recovery)

- `kubectl get pods -n shipit`: all 1/1 Running.
- NEG sizes: api-server=1, web-ui=1.
- `curl /api/health` → 200, `/login` → 200.

## Underlying fragility (open — needs INFRA fix)

Single Spot node + no scheduling headroom = **every preemption is a full
demo outage** (~8 min), and the NEG-drain extends/blanks it to a hard 502
rather than a graceful degrade. This is the recurring "NEG churn" noted in
prior sessions. Candidate infra fixes (cross-repo brief to
`shipit-ai-infra`):

- ≥2 nodes (or a small on-demand node alongside Spot) so a preemption
  never leaves zero schedulable nodes.
- PodDisruptionBudget + topology so api-server/web-ui survive a node loss.
- Faster/again-readiness so NEG re-registration isn't the long pole.
- Consider regional (multi-zone) node pool.

## Operator runbook earned this session

- **kubectl was blocked** by missing `gke-gcloud-auth-plugin` on PATH.
  The binary ships INSIDE the Homebrew cask but isn't symlinked:
  `/opt/homebrew/Caskroom/gcloud-cli/<ver>/google-cloud-sdk/bin/gke-gcloud-auth-plugin`.
  Fix: `export PATH="/opt/homebrew/Caskroom/gcloud-cli/<ver>/google-cloud-sdk/bin:$PATH"`
  then `gcloud container clusters get-credentials shipit-demo --region us-central1`
  (cluster is actually zonal `us-central1-a`; the `--region` form prompts
  the right suggestion).
- When a 502 hits ALL paths incl `/api/health`, check NEG size FIRST
  (`gcloud compute network-endpoint-groups list`) — size 0 = LB has no
  backends = infra/scheduling, not the app. App logs will look healthy.

## Note on the wizard fix (separate concern, same session)

The "empty wizard after Return to ShipIt-AI" the user re-reported is
already fixed and **in the deployed commit** (`a8cb56c`, the #67 merge):
`pending-github-app.ts` + connectors-page `?from=app-manifest` auto-open

- wizard restore effect. Deployed `main` tree is **byte-identical** to
  `more-prod-fixes` (squash merge — so `git merge-base --is-ancestor` reads
  as "NOT in", but `git diff --stat` is empty: trust the tree diff, not
  ancestry). The 2:51 PM empty wizard most likely coincided with this
  cluster churn (mid-recovery pod or a browser-cached pre-fix bundle);
  needs a clean retry to confirm/refute as a real bug.
