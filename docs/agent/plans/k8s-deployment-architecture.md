---
type: plan
status: active
created: 2026-06-04
updated: 2026-06-04
author: claude-session-2026-06-04-deployment
tags: [deployment, kubernetes, gke, distributed, hosting, learning]
importance: core
---

# Kubernetes (GKE) Deployment Architecture

> **Status: DESIGN — pending review.** Deploys the existing **distributed**
> system unchanged onto managed Kubernetes. No application code changes — this is
> infrastructure/IaC work. Supersedes `deployment-runtime-modes` (the Vercel /
> serverless / embedded exploration). See decision
> `hosting-gke-distributed-not-vercel` for why this shape was chosen.

## Goal

Run ShipIt-AI's current distributed stack (web-ui + api-server + core-writer +
Redis + Neo4j) on a managed Kubernetes cluster, optimizing for:

- **No re-architecture** — deploy the system as it's built (`docker-compose.yml`
  → K8s manifests). The earlier distributed/embedded/serverless toggle is NOT
  built.
- **Learning Kubernetes** — the workload maps cleanly to core primitives, making
  this a near-ideal first real K8s project (user goal).
- **Cost ceiling < $60/mo** for the demo/learning tier.

## Platform: GKE (greenfield, <$60, learning)

Chosen for: free control plane (1 zonal/Autopilot cluster), \$300 new-account
trial credit, real-hyperscaler K8s whose skills transfer to a company
EKS/GKE/AKS environment. EKS rejected (~$73/mo control-plane floor); DOKS/Civo
noted as a simpler/cheaper fallback if GCP feels heavy. Full rationale +
rejected alternatives in decision `hosting-gke-distributed-not-vercel`.

## Architecture: docker-compose → K8s primitives

| Component              | K8s resource                                | Notes                                                                                       |
| ---------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `web-ui` (Next.js)     | Deployment + Service (ClusterIP)            | `next start`; API URL baked at image build (see Config)                                     |
| `api-server` (Fastify) | Deployment + Service (ClusterIP)            | HTTP + embedded sync scheduler; always-on so `replicas: 1`+                                 |
| `core-writer`          | Deployment (**no Service**)                 | Always-on BullMQ consumer, no HTTP — the primitive that did NOT fit Cloud Run; trivial here |
| `redis`                | StatefulSet + PVC                           | **Self-hosted in-cluster** — avoids Memorystore's ~$35 floor and teaches stateful workloads |
| `neo4j`                | external (Aura Free)                        | Kept off-cluster to save node RAM and budget                                                |
| routing                | Ingress (`/` → web-ui, `/api` → api-server) | **Single origin**                                                                           |
| `shipit.config.yaml`   | ConfigMap                                   | Mounted into api-server / core-writer                                                       |
| secrets                | Secret                                      | `NEO4J_PASSWORD`, GitHub App private key, session signing secret                            |
| health                 | readiness/liveness probes                   | Off the existing `/api/health`                                                              |

### Key win: single-origin Ingress

Routing `/` → web-ui and `/api` → api-server through one Ingress means the
browser talks to **one origin**. This dissolves the entire cross-domain cookie
problem from the Vercel era — the **Redis session store stays as-is**, CORS is
trivial (same-origin), and `sameSite=Lax` first-party cookies work everywhere.
No stateless-cookie rewrite, no cookie-domain-topology decision needed (that
note is now resolved).

## Cost recipe (~\$45–50/mo, under the $60 ceiling)

| Piece         | Choice                                | ~Cost/mo |
| ------------- | ------------------------------------- | -------- |
| Control plane | GKE, 1 cluster                        | $0       |
| Nodes         | 1× `e2-medium` (4GB) or 2× `e2-small` | ~$26     |
| Redis         | in-cluster StatefulSet + small PVC    | ~$1      |
| Neo4j         | Aura Free (external)                  | $0       |
| Ingress LB    | 1× GCP LoadBalancer                   | ~$18     |

$300 trial credit covers roughly the first ~3 months. Self-hosting Redis (not
Neo4j) is the deliberate balance: learn `StatefulSet`/`PVC` on the light service;
keep the heavy graph DB on Aura Free, off-budget and off-node.

## Config & secrets wiring

- **ConfigMap** holds `shipit.config.yaml`; `${VAR}` placeholders resolved from
  env. Set on the pods:
  - `NEO4J_URI` → Aura `neo4j+s://…` endpoint
  - `NEO4J_USER` → `neo4j`
  - `REDIS_URL` → `redis://redis.<ns>.svc.cluster.local:6379` (in-cluster DNS)
- **Secret** holds `NEO4J_PASSWORD`, the GitHub App private key (mounted as a
  file or env — the manifest wizard's on-disk key path still works because pods
  have a real filesystem, unlike serverless), the webhook secret, and the
  session signing secret (≥32 chars).
- **web-ui build-time API URL:** `web-ui` inlines `NEXT_PUBLIC_SHIPIT_*` at build
  (`SHIPIT_API_URL`). With single-origin Ingress, set it to the public host (e.g.
  `https://demo.example.com`, same origin as the web-ui) or a relative `/api`
  base — baked into the image at build, not a runtime env.

## Build order (learning-oriented)

1. `gcloud` + create GKE cluster + `kubectl` context; create `shipit` namespace.
2. Provision Neo4j Aura Free; create the Neo4j `Secret`.
3. Redis `StatefulSet` + `PVC` + headless `Service`; verify in-cluster DNS.
4. `core-writer` `Deployment` (no Service) — watch it connect to Redis + Aura.
5. `api-server` `Deployment` + `Service`; `ConfigMap` + `Secret`; readiness on
   `/api/health`.
6. `web-ui` `Deployment` + `Service` (image built with the public API URL).
7. `Ingress` + GCP LoadBalancer; map `/` and `/api`; TLS (managed cert).
8. Resource requests/limits; tune replicas.
9. Later: HPA, CI/CD (build → push to Artifact Registry → `kubectl apply`/Helm),
   network policies.

## Out of scope (explicitly)

- No Vercel, no serverless mode, no embedded/distributed toggle (see superseded
  `deployment-runtime-modes` + decision note).
- Company-scale tuning (multi-node pools, in-cluster Neo4j HA, autoscaling
  beyond a basic HPA) deferred until there's real load.

## Status

Design captured, pending review. Next step after approval: `writing-plans` to
produce the step-by-step build (cluster → manifests → secrets → ingress →
deploy), following the build order above.

## Still-relevant open items (independent of hosting)

- `replay-stream-wire-or-cut` — wire or cut the unused Redis replay stream.
- `manual-edit-write-path` — manual claim/edge write endpoints + source-priority
  fix.

## Related

- [hosting-gke-distributed-not-vercel](../decisions/hosting-gke-distributed-not-vercel.md) — why GKE-distributed, alternatives rejected
- [deployment-runtime-modes](deployment-runtime-modes.md) — superseded exploration (Vercel/serverless/embedded)
- [connector-run-storage-redis-not-yaml](../decisions/connector-run-storage-redis-not-yaml.md) — run store in Redis (in-cluster here)
- [core-writer-runs-as-its-own-process](../decisions/core-writer-runs-as-its-own-process.md) — the worker that becomes a no-Service Deployment
- [cookie-domain-topology](../open-questions/cookie-domain-topology.md) — resolved by single-origin Ingress
