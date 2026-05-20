# ADR-011: Service Model Simple Mode

## Status

Accepted

## Date

2026-02-28

## Context

The ShipIt-AI v0.2 design document defines a 4-node service model to represent a single real-world service:

1. **LogicalService** -- The abstract business capability (e.g., "Payment Service"). Owns the service name, tier, and ownership.
2. **Repository** -- The source code repository (e.g., `acme-org/payment-service`). Owns the language, dependencies, and CI/CD configuration.
3. **Deployment** -- A deployed instance in a specific environment (e.g., `payment-service` in `production`). Owns the runtime configuration, replicas, and resource limits.
4. **RuntimeService** -- The running process as observed by monitoring (e.g., Datadog service `payment-service-prod`). Owns metrics, SLOs, and health status.

These four nodes are connected by relationships: `LogicalService -[:IMPLEMENTED_BY]-> Repository`, `LogicalService -[:DEPLOYED_AS]-> Deployment`, `Deployment -[:OBSERVED_AS]-> RuntimeService`.

### The full model is correct but heavy for small organizations

For organizations with 500+ services, multiple environments, monorepos, and sidecars, the 4-node model is essential. A single LogicalService might have 3 repositories (main service, shared library, config repo), 4 deployments (dev, staging, production-us, production-eu), and 6 runtime services (main process, sidecar proxy, canary, and their monitoring entities).

For organizations with fewer than 100 services, where each service has one repo, one deployment, and one runtime identity, the 4-node model creates unnecessary complexity:

- **4x node count.** 50 services become 200 nodes before adding Teams, Persons, or APIs.
- **Query complexity.** "Who owns this service?" requires traversing from RuntimeService through Deployment to LogicalService to Team. In the simple case, this is three hops where one would suffice.
- **Onboarding friction.** New users must understand four node types and their relationships before they can reason about the graph. The mental model is heavier than necessary.
- **Connector mapping complexity.** Connector authors must decide which of the four node types their data maps to, even when the distinction is not meaningful for the source system (e.g., GitHub knows about repos but not deployments).

### Monorepo and sidecar patterns further complicate the model

- **Monorepos:** A single Repository maps to multiple LogicalServices. The 1:1 assumption of simple deployments breaks down.
- **Sidecars:** A single Deployment may have multiple containers (main service + Envoy proxy + log collector). Each sidecar may appear as a separate RuntimeService in monitoring.

These patterns are common in larger organizations and require the full 4-node model to represent accurately.

## Decision

We will support two service model modes, selectable via schema configuration (ADR-006):

### Full Model (Default)

The 4-node model (LogicalService, Repository, Deployment, RuntimeService) is the default for all deployments. All documentation, connectors, and MCP tools are designed for this model.

### Simple Mode

A configuration option collapses the 4-node model into a single **Service** node that carries properties from all four node types:

```yaml
# schema/ontology.yaml
service_model: simple # Options: "full" (default) | "simple"
```

In Simple Mode:

- A single `:Service` node represents the entire service, combining properties from LogicalService, Repository, Deployment, and RuntimeService.
- Properties that exist on multiple node types in the full model are flattened: `name`, `tier`, `owner` (from LogicalService), `repo_url`, `language` (from Repository), `environment`, `replicas` (from Deployment), `health_status`, `slo_target` (from RuntimeService).
- Relationships connect directly to the Service node: `Team -[:OWNS]-> Service`, `Service -[:DEPENDS_ON]-> Service`, `Service -[:DEPLOYED_IN]-> Environment`.
- The MCP tools (`blast_radius`, `entity_detail`, etc.) operate identically -- they return Service nodes instead of the 4-node subgraph.

### Recommended usage

| Organization profile                      | Recommended mode                                                         |
| ----------------------------------------- | ------------------------------------------------------------------------ |
| < 100 services, no monorepos, no sidecars | Simple Mode                                                              |
| 100+ services, or monorepos, or sidecars  | Full Model                                                               |
| Starting small, expect to grow            | Start Full Model (migration Simple-to-Full is supported; reverse is not) |

### Migration: Simple to Full

A migration script converts Simple Mode to Full Model:

1. For each `:Service` node, create a `:LogicalService`, `:Repository`, `:Deployment`, and `:RuntimeService` node.
2. Distribute properties to the appropriate node type based on the schema definition.
3. Create the `IMPLEMENTED_BY`, `DEPLOYED_AS`, and `OBSERVED_AS` relationships.
4. Redirect all incoming/outgoing relationships from the old `:Service` node to the appropriate new node.
5. Delete the old `:Service` node.

This migration is a one-time operation and is destructive (the Simple Mode graph structure is replaced). A backup should be taken before migration.

### Migration: Full to Simple (NOT supported)

Collapsing the Full Model to Simple Mode is not supported because:

- The 4-node model represents real structural distinctions (one service with three repos and four deployments). Collapsing to a single node loses this information.
- Property name collisions would require arbitrary resolution rules (which `name` wins -- the LogicalService name or the Repository name?).
- Relationship targets become ambiguous (does `DEPENDS_ON` connect to the logical service or the runtime instance?).

Users who outgrow Simple Mode should migrate to Full Model, not the reverse.

### Monorepo and sidecar guidance

For organizations using the Full Model with monorepos or sidecars:

**Monorepos:**

- One `:Repository` node for the monorepo.
- Multiple `:LogicalService` nodes, each linked to the same Repository via `IMPLEMENTED_BY`.
- The linking key for each service includes a path within the monorepo (e.g., `github_slug: acme-org/monorepo/services/payment`).

**Sidecars:**

- One `:Deployment` node for the pod.
- Multiple `:RuntimeService` nodes for each container (main service, sidecar proxy, log collector).
- The main RuntimeService has a `role: primary` property. Sidecars have `role: sidecar`.
- The `blast_radius` tool can optionally filter by `role: primary` to exclude sidecar noise.

## Consequences

### Positive

- **Lower barrier to entry for small organizations.** Simple Mode reduces the concept count from four node types to one. The graph is immediately understandable without reading documentation about the full service model.
- **Faster onboarding.** Connector mapping in Simple Mode is straightforward: every source maps to a Service node. No need to distinguish between LogicalService, Repository, Deployment, and RuntimeService.
- **Fewer nodes, simpler queries.** A 50-service organization in Simple Mode has ~50 Service nodes plus Teams and Persons, instead of ~200 nodes in the full model. MCP queries are faster and simpler.
- **Migration path exists.** Organizations that outgrow Simple Mode can migrate to Full Model without re-ingesting data from connectors.

### Negative

- **Two code paths.** The Core Writer, MCP tools, and UI must handle both models. Conditional logic based on `service_model` configuration adds code complexity. **Mitigation:** The Service node in Simple Mode uses a superset of properties. MCP tools query by label (`:Service` or `:LogicalService`) based on configuration. The branching is at the query level, not the business logic level.
- **Simple-to-Full migration is lossy.** A Simple Mode Service node does not distinguish which properties came from which source system. The migration script assigns properties to node types based on schema definitions, but some assignments may be ambiguous. **Mitigation:** The `_claims` property (ADR-002) preserves source provenance, enabling the migration script to assign properties accurately.
- **Full-to-Simple not supported.** Organizations that start in Full Model and later want to simplify are stuck. **Mitigation:** The recommendation is to start with Full Model if there is any expectation of growth. Simple Mode is for organizations that are confident they will stay small.
- **Documentation burden.** All documentation, tutorials, and examples must cover both modes. **Mitigation:** Default documentation uses Full Model. Simple Mode is documented as an optional configuration with a dedicated page.

### Neutral

- Simple Mode and Full Model are mutually exclusive at the instance level. A single ShipIt-AI deployment cannot mix both modes for different services. This is a deliberate simplification to avoid per-entity model configuration complexity.

## Alternatives Considered

### Alternative 1: Full Model Only, No Simple Mode

- **Pros:** One code path. No conditional logic. No migration tooling. All documentation is consistent.
- **Cons:** Small organizations (< 100 services) deal with unnecessary complexity. 4x node count for simple topologies. Higher cognitive load for new users.
- **Why rejected:** The 4-node model is correct for complex organizations but is a barrier to adoption for the small-team segment. Simple Mode removes this barrier without compromising the full model for larger deployments.

### Alternative 2: Auto-Detect Model Based on Entity Count

- **Pros:** No manual configuration. The system starts in Simple Mode and automatically migrates to Full Model when entity count exceeds a threshold.
- **Cons:** Unpredictable behavior. Users do not know when the migration will occur. The migration changes the graph structure, potentially breaking saved queries or dashboards. Automatic migration during production use is risky.
- **Why rejected:** Schema changes should be explicit, predictable, and operator-controlled. Automatic migration based on entity count is a recipe for surprises.

### Alternative 3: Flexible Per-Entity Model (Some Services Simple, Some Full)

- **Pros:** Maximum flexibility. Each service can use the model that fits its complexity.
- **Cons:** Enormous complexity in the Core Writer, MCP tools, and UI. Every query must handle both models simultaneously. Relationship semantics vary per entity. Identity resolution must match across model types.
- **Why rejected:** The complexity is not justified. Organizations that need the full model for some services generally need it for all services (because the complex services interact with the simple ones). Instance-level configuration is the right granularity.
