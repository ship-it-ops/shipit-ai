# ADR-003: Phase 1 MVP Scope Definition

## Status

Accepted

## Date

2026-02-28

## Context

The ShipIt-AI v0.2 design document defined Phase 1 as a 3-month effort with 13 major deliverables:

1. Core Writer with full resolution engine
2. Neo4j schema and migrations
3. GitHub connector
4. Kubernetes connector
5. Backstage connector
6. Datadog connector
7. MCP server with 6 tools
8. Schema Editor UI (visual, drag-and-drop)
9. Claim Explorer UI
10. Docker Compose deployment
11. Vector database + embedding pipeline
12. Event bus (Kafka)
13. Onboarding wizard

Multiple independent reviewers flagged this as severely overscoped. Even with AI agents accelerating implementation, 13 major deliverables in 12 weeks means each feature gets less than a week of development, testing, and integration. The predictable outcome is 13 half-working features rather than a small number of fully working ones.

### Key risks of the original scope

- **Integration risk.** Each connector + Core Writer + Neo4j + MCP server integration path is non-trivial. Debugging data flow through 4+ components when the graph output is wrong requires all components to be working correctly.
- **Demo risk.** If the walking skeleton does not work end-to-end by week 4, there is nothing to demonstrate to stakeholders or early users. Individual components in isolation do not tell the ShipIt-AI story.
- **Quality risk.** Spreading effort across 13 deliverables means no single feature is production-quality. The MCP tools — the primary user-facing value — get the same time allocation as infrastructure plumbing.
- **AI agent development note.** While AI agents will be writing the majority of the implementation code, they still require well-defined interfaces, clear acceptance criteria, and human review of architectural decisions. AI agents are faster at writing code but do not eliminate integration testing, debugging, or design iteration.

### What matters most

The single most important thing ShipIt-AI can demonstrate is: **An AI agent answers a question about infrastructure relationships using data that ShipIt-AI automatically collected.** Everything else is enablement for that moment.

## Decision

Phase 1 is split into two sub-phases with a strict milestone gate between them.

### Phase 1a: Walking Skeleton (Weeks 1-4)

**Milestone definition:** "A developer can run `docker-compose up`, connect their GitHub organization, and within 15 minutes ask an AI agent 'what is the blast radius of repo X?' and get a correct answer."

Deliverables:

1. **GitHub Connector** — Reads repositories, CODEOWNERS, topics/labels, and dependency files (package.json, go.mod). Emits entity events for Services, Repositories, Teams, and DEPENDS_ON relationships.

2. **In-Process Event Queue** — A simple BullMQ-on-Redis queue (or in-memory queue for development) that the GitHub connector publishes to and the Core Writer consumes from. Implements the Event Bus Interface so it can be swapped for Kafka later (see ADR-004).

3. **Core Writer (Minimal)** — Consumes entity events, applies a basic resolution strategy (latest-wins with source priority), and writes/merges entities and relationships to Neo4j. Stores claims as JSON on entity nodes (see ADR-002). Supports the core entity types: Service, Repository, Team, Person, and relationship types: OWNS, DEPENDS_ON, CONTRIBUTES_TO.

4. **Neo4j Schema Bootstrap** — Constraints, indexes, and the initial ontology loaded from a YAML schema file (see ADR-006). Includes a seed script for smoke testing.

5. **MCP Server (3 tools):**
   - `blast_radius` — Given an entity (by canonical ID or name), return all entities within N hops and their relationship types.
   - `entity_detail` — Given an entity, return all properties, resolved values, and claims.
   - `schema_info` — Return the current ontology (entity types, relationship types, properties).

6. **Docker Compose** — App server, Neo4j, Redis. Three containers. Under 2 GB RAM total.

7. **Smoke test suite** — An end-to-end test that runs the GitHub connector against a fixture repository, verifies entities appear in Neo4j, and verifies the MCP tools return correct responses.

### Phase 1b: Second Connector + Onboarding (Weeks 5-8)

Deliverables:

1. **Kubernetes Connector** — Reads Deployments, Services, ConfigMaps, Namespaces, and annotations. Maps K8s resources to the ShipIt-AI ontology. Links K8s Deployments to GitHub repos via naming conventions or annotations.

2. **Onboarding Wizard (Basic)** — A step-by-step web UI that guides users through: (a) adding a GitHub token, (b) selecting repositories/orgs, (c) triggering the first sync, (d) verifying data in the graph. No drag-and-drop, no visual editor — just forms and progress indicators.

3. **Docker Compose (Production-Lite)** — Add health checks, restart policies, volume mounts for Neo4j data persistence, and environment variable documentation. The goal is a deployment that survives a host restart.

4. **Additional MCP tools:**
   - `list_entities` — Search/filter entities by type, name, or tag.
   - `relationship_path` — Find the shortest path between two entities.

### Explicitly deferred to Phase 2+

The following items from the v0.2 design are NOT in Phase 1:

| Item                        | Deferred To | Reason                                                                        |
| --------------------------- | ----------- | ----------------------------------------------------------------------------- |
| Schema Editor UI (visual)   | Phase 2     | Multi-month UX effort (see ADR-006)                                           |
| Vector DB (Weaviate/Qdrant) | Phase 2     | Insufficient embeddable data in Phase 1 (see ADR-005)                         |
| Kafka event bus             | Phase 2     | Resource-heavy, unnecessary at small scale (see ADR-004)                      |
| Backstage connector         | Phase 2     | Requires Backstage instance; GitHub + K8s are sufficient to demonstrate value |
| Datadog connector           | Phase 2     | Observability data enriches the graph but is not core to the walking skeleton |
| PagerDuty connector         | Phase 2     | On-call data is valuable but not foundational                                 |
| Jira connector              | Phase 3     | Enrichment data, not structural                                               |
| `semantic_search` MCP tool  | Phase 2     | Requires vector DB                                                            |
| `change_timeline` MCP tool  | Phase 2     | Requires event history storage                                                |
| Multi-tenant support        | Phase 3     | Enterprise feature                                                            |
| RBAC / SSO                  | Phase 3     | Enterprise feature                                                            |

## Consequences

### Positive

- **Demonstrable value by week 4.** The walking skeleton proves the entire data pipeline works: connector ingests data, Core Writer builds the graph, MCP server answers questions. This is the "magic moment" that sells ShipIt-AI.
- **Reduced integration risk.** Fewer components means fewer integration surfaces. The Phase 1a stack has exactly one data path: GitHub -> Queue -> Core Writer -> Neo4j -> MCP. If something breaks, the debugging surface is small.
- **Higher quality per feature.** Each of the 7 Phase 1a deliverables gets approximately 3 days of focused development + testing, rather than being squeezed into 1 day.
- **Clear milestone gate.** Phase 1b only starts when Phase 1a's walking skeleton is working end-to-end. This prevents the "everything is 80% done but nothing works" failure mode.
- **AI agent efficiency.** AI agents work best with clear, small, well-defined tasks. "Build the GitHub connector that emits these 4 entity types" is a better AI agent prompt than "build 4 connectors with different APIs, different entity types, and different error handling."

### Negative

- **Delayed breadth.** Users who need Backstage, Datadog, or PagerDuty integration must wait for Phase 2. Early adopters with only GitHub + K8s are the primary Phase 1 audience. **Mitigation:** The Connector SDK is designed so that community connectors can be developed in parallel by others, even during Phase 1.
- **Perception of limited scope.** Stakeholders who read the v0.2 design may perceive Phase 1 as a regression in ambition. **Mitigation:** Frame Phase 1 as "the working foundation that all other features build on" rather than "a cut-down version." The walking skeleton milestone is compelling because it is demonstrably real.
- **Schema rigidity.** Without the Schema Editor UI, Phase 1 users define the ontology in YAML. This is acceptable for platform engineers but not for non-technical users. **Mitigation:** Provide a well-documented default schema that covers the common case (services, repos, teams, deployments, dependencies). Most users will not need to modify it.
- **No semantic search.** Phase 1 search is limited to exact ID, name, or substring matching. Users cannot ask "find services related to payments." **Mitigation:** Structural graph queries (blast radius, relationship path) are the primary value proposition. Semantic search enhances but does not replace them.

## Alternatives Considered

### Alternative 1: Original v0.2 Phase 1 Scope (13 deliverables in 12 weeks)

- **Description:** Ship all 13 deliverables as originally planned, relying on AI agents to compensate for the aggressive timeline.
- **Rejected because:** AI agents accelerate coding but do not eliminate integration testing, debugging, design iteration, or user feedback cycles. 13 deliverables in 12 weeks, even with AI assistance, results in shallow implementation across the board. The risk of delivering nothing that works end-to-end is too high.

### Alternative 2: Single Phase 1 with 8-Week Timeline and 8 Deliverables

- **Description:** A single 8-week phase with a mid-point between the original scope and the proposed scope — GitHub + K8s connectors, Core Writer, MCP server (5 tools), Docker Compose, basic onboarding, but no Schema Editor or Vector DB.
- **Rejected because:** Without the explicit Phase 1a/1b split and the walking skeleton milestone gate, there is no forcing function to ensure end-to-end integration works before adding more features. The sub-phase structure with a concrete milestone is the key insight, not just the scope reduction.

### Alternative 3: Phase 1 with Only the MCP Server (No UI)

- **Description:** Ship only the backend pipeline (connector, writer, graph, MCP server) with no web UI at all. Users interact entirely through AI agents.
- **Rejected because:** The onboarding wizard (even a basic one) is essential for first-time setup. Without it, users must configure GitHub tokens, trigger syncs, and debug connection issues via CLI or environment variables. The basic onboarding wizard in Phase 1b is a minimal investment that dramatically improves first-run experience.
