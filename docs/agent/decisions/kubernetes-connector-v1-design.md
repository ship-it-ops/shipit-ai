---
type: decision
status: active
created: 2026-09-16
updated: 2026-09-16
author: claude-session-2026-09-16-k8s-connector
tags: [connectors, kubernetes, scheduler, core-writer, absence, linking]
importance: core
---

# Kubernetes connector v1: poll-based, both access modes, absence sweep, tiered repo links

## Context

Phase 1b's first deliverable (ADR-003) was never started; `packages/connectors/kubernetes`
is a two-line scaffold. Designing it surfaced two platform gaps: nothing ever removes a
node, and nothing emits `LogicalService`, so the service-centric UI (Incident Mode,
`OWNS`) has no anchor. Full design:
`docs/superpowers/specs/2026-09-16-kubernetes-connector-design.md`.

## Decision

1. **Both access modes in v1**: in-cluster ServiceAccount and uploaded kubeconfig/token
   (files in the key dir, durable via the existing `shipit-connector-apps` GSM blob).
   Kubeconfigs using `exec`/`auth-provider` are rejected — the plugin binary is not in the pod.
2. **Poll on the existing BullMQ scheduler** (default every 5 min, full list). No watch;
   the connector keeps a `refetchWorkload()` seam for a later watch/webhook layer.
3. **Absence via end-of-sync sweep**: scheduler publishes a `sync.completed { startedAt }`
   control envelope only after a `success` + `full` run; the writer sets `_absent_since` on
   that instance's nodes whose `_last_synced` predates the run; every write/touch clears it;
   default reads (api + MCP) exclude absent unless `include_absent`. No hard delete.
4. **Tiered repository linking** as explicit edges (never linking-key merges, which are
   same-entity): annotation `shipit.ai/github-repo` (1.0) > image-name match (0.7) >
   `app.kubernetes.io/name` match (0.6); edges target predicted Repository ids and the
   writer drops them when the target is missing.
5. **Connector-type factory** in api-server (`services/connector-types/`) replaces GitHub
   branches in scheduler, registry create, probe and summary.
6. **Emit `LogicalService`** per app (global id `shipit://logical-service/default/<name>`,
   claims 0.7) with `DEPLOYED_AS`, `IMPLEMENTED_BY`, and `Team OWNS LogicalService`.

## Alternatives Considered

- **Watch + hourly resync (the original plan)**: rejected for v1 — needs a long-lived
  runner outside the harness; poll reuses everything.
- **Hard delete on sweep**: rejected — loses history and anything an agent just cited.
- **Annotation-only linking**: rejected — nothing links until every chart is annotated.
- **In-cluster agent process**: rejected — contradicts poll-on-scheduler and cannot serve
  uploaded credentials.
- **OCI image source label as a tier**: deferred — needs registry credentials.

## Consequences

- GitHub instances gain the sweep for free (deleted repos become absent).
- Envelope gains an optional `kind`; existing producers/consumers unaffected.
- One instance per cluster; `Environment` and `LogicalService` ids are global so later
  sources (Backstage, Datadog) merge by primary key.
- Spec 2 (Connector Hub wizard mirroring GitHub) follows as a separate spec.

## Revisit Triggers

- A customer needs sub-minute freshness → add the watch layer on the refetch seam.
- Argo CD / Flux present in a target cluster → add tracking-id as tier 2.
- Graph outgrows demo scale → the parked Neo4j index question becomes active.

## Related

- [github-connector-architecture-v1](./github-connector-architecture-v1.md) — shape mirrored
- [connector-apps-gsm-blob-durability](./connector-apps-gsm-blob-durability.md) — credential durability reused
- [webhook-receiver-design](./webhook-receiver-design.md) — refetch seam precedent
- [neo4j-no-indexes-declared](../open-questions/neo4j-no-indexes-declared.md) — revisit after landing
