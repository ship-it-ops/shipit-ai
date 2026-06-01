# Architecture

## System Overview

ShipIt-AI is a TypeScript monorepo that builds and maintains a knowledge graph of your software ecosystem. Data flows in one direction: connectors pull from external sources, normalize into canonical entities, publish through an event bus, and a single Core Writer merges everything into Neo4j with conflict resolution.

```
External Sources           Event Bus              Graph              Consumers
┌──────────┐          ┌──────────────┐      ┌──────────┐      ┌──────────────┐
│  GitHub   │──┐      │              │      │          │      │  MCP Server  │
├──────────┤  │      │   BullMQ     │      │  Neo4j   │      ├──────────────┤
│  K8s     │──┼──▶   │   Redis      │──▶   │  5.x     │──▶   │  API Server  │
├──────────┤  │      │   Streams    │      │          │      ├──────────────┤
│ Custom   │──┘      │              │      │          │      │   Web UI     │
└──────────┘          └──────────────┘      └──────────┘      └──────────────┘
                      Connector SDK           Core Writer         Fastify/MCP/Next.js
```

## Package Dependency Graph

```
@shipit-ai/shared                    (no internal deps)
    │
    ├── @shipit-ai/event-bus
    │       │
    │       ├── @shipit-ai/core-writer
    │       │
    │       ├── @shipit-ai/connector-sdk
    │       │       │
    │       │       ├── @shipit-ai/connector-github
    │       │       └── @shipit-ai/connector-kubernetes
    │       │
    │       └── @shipit-ai/api-server
    │
    └── @shipit-ai/mcp-server

@shipit-ai/web-ui                    (no internal deps — HTTP to API Server)
```

All internal dependencies use `workspace:*` protocol via pnpm workspaces.

## Four-Node Service Model

The knowledge graph centers on four core node types that model the lifecycle of a service:

```
                    ┌─────────────────┐
                    │ LogicalService  │
                    │ "config-service"│
                    └──┬──────────┬───┘
                       │          │
              IMPLEMENTED_BY   DEPLOYED_AS
                       │          │
              ┌────────▼──┐  ┌────▼────────┐
              │ Repository │  │ Deployment  │
              │ "config-   │  │ "config-svc │
              │  service"  │  │  -prod"     │
              └────────┬───┘  └──┬──────┬───┘
                       │         │      │
                  BUILT_FROM  RUNS_IMAGE  EMITS_TELEMETRY_AS
                       │         │      │
              ┌────────▼──┐      │  ┌───▼──────────┐
              │  Build     │◀────┘  │RuntimeService│
              │  Artifact  │        │"config-svc"  │
              └────────────┘        └──────────────┘
```

**LogicalService** is the anchor — a named, team-owned concept that persists across deployments, repos, and renames. The other three types capture implementation, runtime, and observability aspects.

Supporting node types (Team, Person, Environment, Pipeline, Monitor, Namespace, Cluster) connect to the core four via relationships like `OWNS`, `MEMBER_OF`, `RUNS_IN_ENV`, `BUILT_BY`, and `MONITORS`.

## Data Flow

### 1. Connector → Event Bus

Connectors implement the `ShipItConnector` interface:

```
authenticate() → discover() → fetch() → normalize() → sync()
```

The `ConnectorHarness` wraps connectors and handles:

- Sync state management (IDLE → SYNCING → COMPLETING → IDLE/FAILED/DEGRADED)
- Batch publishing to the event bus (default batch size: 100)
- Error handling and state transitions

Each entity is normalized into a `CanonicalEntity` containing `CanonicalNode[]` and `CanonicalEdge[]`.

### 2. Event Bus

Events are published as `EventEnvelope` messages:

```typescript
{
  id: string,              // UUID
  timestamp: string,       // ISO 8601
  connector_id: string,
  idempotency_key: string, // {connector_id}:{entity_key}:{event_version}
  payload: CanonicalEntity
}
```

The event bus uses BullMQ queues for processing and Redis Streams for replay support. Events are retained for 7 days by default.

### 3. Core Writer → Neo4j

The Core Writer is the **sole writer** to Neo4j. For each event it:

1. **Idempotency check** — Skips duplicate events using `_IdempotencyLog` nodes (TTL: 30 days)
2. **Identity reconciliation** — Matches incoming entities to existing nodes:
   - Step 1: Primary Key match (canonical ID)
   - Step 2: Linking Key match (source-specific ID like `github://org/repo`)
   - Step 3: Create new entity if no match
3. **Claim resolution** — Merges PropertyClaims and resolves effective values per the configured strategy
4. **Node merge** — `MERGE` node by label + canonical ID, `SET` resolved properties and serialized `_claims` JSON
5. **Edge merge** — `MATCH` source/target nodes, `MERGE` relationship with metadata

Batching: Events are buffered and flushed at 500 events or every 5 seconds.

## Claim Resolution Lifecycle

Every property value in the graph is backed by one or more PropertyClaims:

```typescript
{
  property_key: "owner",
  value: "platform-team",
  source: "github",
  source_id: "github://acme/config-service",
  ingested_at: "2026-02-28T12:00:00Z",
  confidence: 0.9,
  evidence: "CODEOWNERS file"
}
```

When multiple sources assert different values for the same property, the resolution strategy determines the winner:

| Strategy                | Behavior                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------- |
| `HIGHEST_CONFIDENCE`    | Effective confidence (with time decay) wins; tiebreak by recency                      |
| `MANUAL_OVERRIDE_FIRST` | Manual claims always win; fallback to `HIGHEST_CONFIDENCE`                            |
| `AUTHORITATIVE_ORDER`   | Source priority: manual > backstage > github > kubernetes > datadog > jira > identity |
| `LATEST_TIMESTAMP`      | Most recently ingested value wins                                                     |
| `MERGE_SET`             | Union all values into an array (for tags, labels)                                     |

Confidence decays over time: `effective = max(0, base - 0.01 * weeks_since_ingestion)`.

Claims are stored as a JSON `_claims` array on each node (see [ADR-002](adrs/ADR-002-propertyclaim-storage.md)), reducing write operations from ~45 to ~2 per entity update.

## Identity Reconciliation

Entities are identified across sources using a two-step ladder (Phase 1):

1. **Primary Key** — Canonical ID (`shipit://label/namespace/name`). Exact match.
2. **Linking Key** — Source-specific ID (e.g., `github://acme-corp/config-service`, `k8s://prod-cluster/default/config-svc`). Stored as `_LinkingKey` nodes in Neo4j.

Phase 2 will add fuzzy matching for entities that can't be linked by exact keys.

### Canonical ID Format

```
shipit://{label}/{namespace}/{name}
```

For entities owned by a multi-tenant source (e.g., GitHub orgs), `{name}` is
scoped by the owning tenant to avoid silent cross-tenant collisions:

```
shipit://{label}/{namespace}/{scope}/{name}
```

Examples:

- `shipit://repository/default/acme-corp/config-service`
- `shipit://team/default/acme-corp/platform-team`
- `shipit://pipeline/default/acme-corp/config-service-ci`
- `shipit://deployment/production/config-svc-prod`
- `shipit://person/default/alice` _(unscoped — GitHub logins are globally unique)_

## MCP Server

The MCP Server connects to Neo4j directly (read-only) and exposes 8 tools via the Model Context Protocol's stdio transport. All responses are wrapped in a standard envelope with metadata (`_meta`) including query time, data quality indicators, and suggested follow-up queries.

Guardrails for the `graph_query` tool:

- Write operations are rejected
- Variable-length patterns are limited to 6 hops
- Results are capped at 1000 rows
- Queries timeout after 10 seconds
- Rate limited to 100 calls per day

## API Server

Fastify 4 with OpenAPI documentation via `@fastify/swagger`. Routes are organized into four groups:

- `/api/health` — Health check
- `/api/connectors` — Connector CRUD and sync triggers
- `/api/schema` — Schema management (YAML)
- `/api/graph` — Graph queries (stats, neighborhood, search)

## Web UI

Next.js 14 (App Router) with:

- Cytoscape.js for interactive graph visualization
- Zustand for state management
- TanStack React Query for data fetching
- Tailwind CSS + shadcn/ui components
