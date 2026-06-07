---
type: decision
status: active
created: 2026-06-04
updated: 2026-06-04
author: claude-session-2026-06-04-deployment
tags: [deployment, hosting, kubernetes, gke, vercel, architecture]
importance: core
---

# Host the distributed system on GKE; do not use Vercel/serverless

## Context

ShipIt-AI needs a hosting target for a demo/hobby tier (with a path to company
scale). The user already uses Vercel and initially wanted everything there for
simplicity. A long 2026-06-04 design exploration (captured in superseded plan
`deployment-runtime-modes`) worked through what that would actually require.

The system is **persistent and stateful by nature**: an always-on api-server with
an embedded poller, an always-on non-HTTP queue worker (`core-writer`), Redis
(BullMQ + sessions + run store), and Neo4j. Connector sync runs can take **many
minutes** ("bucket C").

## Decision

Deploy the **existing distributed stack unchanged** on **managed Kubernetes
(GKE)**. No application code changes. See plan `k8s-deployment-architecture` for
the architecture and cost recipe. Greenfield footprint + <$60/mo ceiling +
explicit goal to **learn Kubernetes** drove both "K8s" and "GKE."

## Alternatives Considered

- **All-on-Vercel (serverless):** rejected. Multi-minute syncs exceed Vercel's
  function duration cap (Hobby 300s / Pro ~800s); `waitUntil`/`after` are still
  capped; Workflow DevKit would require rewriting the crawler into durable steps.
  Worse, serverless has no persistent filesystem/Redis, so connector config,
  schema, run history, and the GitHub App private key (all currently on
  disk/Redis) would have to be relocated to external stores — a large
  re-architecture to fit the platform. The user explicitly chose to stop bending
  the system to Vercel.
- **Embedded single-process mode (Fly):** viable and cheap, but unnecessary once
  Vercel was dropped — a container host runs the distributed stack as-is. Kept in
  the superseded plan as a possible future optimization, not built.
- **Cloud Run / Fargate (non-K8s containers):** workable, but the user wants to
  learn Kubernetes specifically. Cloud Run also fights the always-on non-HTTP
  worker (needs Worker Pools or min-instances).
- **EKS:** rejected for this tier — ~$73/mo control-plane floor blows the budget
  for a hobby/learning cluster.
- **DOKS/Civo:** cheaper/simpler managed K8s; noted as a fallback if GKE feels
  heavy, but GKE's free control plane + $300 credit + transferable hyperscaler
  experience won.

## Consequences

- This becomes a **deployment/IaC project**, not an app change. The codebase
  ships as-is.
- Single-origin Ingress (`/` → web-ui, `/api` → api-server) keeps the **Redis
  session store** and avoids any cross-domain cookie work — resolving
  open-question `cookie-domain-topology`.
- The distributed/embedded/serverless toggle, stateless-cookie auth, and
  state-relocation work explored on 2026-06-04 are all **not** pursued.
- Company-scale K8s hardening (HA Neo4j, autoscaling, multi-pool) is deferred.

## Revisit Triggers

- Going commercial, or outgrowing Aura Free (200k nodes / 400k rels) → revisit
  managed-vs-self-hosted Neo4j and cluster sizing.
- If hosting cost or ops burden becomes a problem → reconsider the embedded
  single-process mode (still documented) or a cheaper managed K8s (DOKS/Civo).

## Related

- [k8s-deployment-architecture](../plans/k8s-deployment-architecture.md) — the architecture this decision selects
- [deployment-runtime-modes](../plans/deployment-runtime-modes.md) — superseded exploration that led here
- [cookie-domain-topology](../open-questions/cookie-domain-topology.md) — resolved as a consequence
