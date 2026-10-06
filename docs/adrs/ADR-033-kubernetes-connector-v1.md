# ADR-033: Kubernetes Connector v1 — Poll-Based, Both Access Modes, Absence Sweep, Tiered Repository Links

## Status

Accepted

## Date

2026-09-16

## Context

The Kubernetes connector was the first deliverable of Phase 1b (ADR-003) and had never been started. Designing it exposed two platform gaps: nothing ever removed a node from the graph, and nothing emitted `LogicalService`, so the service-centric UI (Incident Mode, ownership) had no anchor.

## Decision

1. **Both access modes:** an in-cluster service account, or an uploaded kubeconfig or token kept in the key directory and durable through the connector blob (ADR-025). Kubeconfigs that need an `exec` plugin are refused; the connector parses and allow-lists kubeconfig text itself.
2. **Polling on the existing scheduler** (default every five minutes, a full list), with a `refetchWorkload()` seam for a later watch layer.
3. **Absence by end-of-sync sweep:** after a successful full run the scheduler publishes a `sync.completed` control envelope; the writer marks that connector's nodes not seen in the run with `_absent_since`. Default reads in the API and the MCP tools hide absent nodes unless `include_absent` is set. No hard delete. The sweep is opt-in per connector type (`sweepsAbsent`): Kubernetes on, GitHub off until its full sync is exhaustive.
4. **Tiered repository linking** as explicit edges: the `shipit.ai/github-repo` annotation (1.0), then an image-name match (0.7), then `app.kubernetes.io/name` (0.6); the writer drops an edge whose target is missing.
5. **A connector-type factory** in the api-server (`services/connector-types/`) replaces GitHub-specific branches in the scheduler, registry, probe and summary.
6. **`LogicalService` per application**, with `DEPLOYED_AS`, `IMPLEMENTED_BY` and `Team OWNS LogicalService` edges.

## Consequences

### Positive

- The graph finally has services and can forget what disappeared, without losing history.
- A second connector type proved the factory and the Connector Hub wizard pattern.

### Negative

- No watch: freshness is the poll interval.
- Absence sweeps rely on a full, exhaustive list; GitHub's capped sync cannot use them yet.

### Neutral

- `Environment` and `LogicalService` ids are global so later sources merge by primary key.

## Alternatives Considered

### Watch plus hourly resync

- **Cons:** Needs a long-lived runner outside the scheduler harness.

### Hard delete on sweep

- **Cons:** Loses history and anything an agent just cited.

## References

- `docs/agent/decisions/kubernetes-connector-v1-design.md`
- `docs/superpowers/specs/2026-09-16-kubernetes-connector-design.md`, `docs/superpowers/specs/2026-09-24-connector-hub-kubernetes-design.md`
