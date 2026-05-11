# ShipIt-AI

**AI-Ready Knowledge Graph Builder for Software Ecosystems**

## What is ShipIt-AI?

ShipIt-AI discovers, maps, and maintains your software ecosystem as a queryable Neo4j knowledge graph. Connectors pull data from GitHub, Kubernetes, and other sources, normalizing it into a unified service model with conflict-resolving PropertyClaims. The graph is exposed via MCP tools so AI agents like Claude can answer questions about ownership, blast radius, dependencies, and more — without manual catalog maintenance.

## Architecture

```
┌──────────────┐  ┌─────────────┐  ┌─────────────┐
│   GitHub     │  │ Kubernetes  │  │  Custom...  │
│  Connector   │  │  Connector  │  │  Connector  │
└──────┬───────┘  └──────┬──────┘  └──────┬──────┘
       │                 │                │
       └────────┬────────┴────────┬───────┘
                │                 │
          CanonicalEntities + PropertyClaims
                │                 │
        ┌───────▼─────────────────▼───────┐
        │         Event Bus (BullMQ)      │
        │           Redis Streams         │
        └───────────────┬─────────────────┘
                        │
                ┌───────▼───────┐
                │  Core Writer  │
                │  (sole graph  │
                │    writer)    │
                └───────┬───────┘
                        │  Claim Resolution
                        │  Identity Matching
                ┌───────▼───────┐
                │    Neo4j 5    │
                │ Knowledge     │
                │    Graph      │
                └──┬─────┬───┬──┘
                   │     │   │
         ┌─────────┘     │   └──────────┐
         │               │              │
  ┌──────▼──────┐ ┌──────▼──────┐ ┌─────▼──────┐
  │ MCP Server  │ │ API Server  │ │   Web UI   │
  │ (stdio)     │ │ (Fastify)   │ │ (Next.js)  │
  └─────────────┘ └─────────────┘ └────────────┘
```

## Key Features

- **PropertyClaim System** — Every fact carries source, confidence score, and timestamp. Multiple sources can assert different values; configurable resolution strategies pick the winner.
- **Five Resolution Strategies** — `HIGHEST_CONFIDENCE`, `MANUAL_OVERRIDE_FIRST`, `AUTHORITATIVE_ORDER`, `LATEST_TIMESTAMP`, `MERGE_SET` — with automatic time-decay of confidence scores.
- **Identity Reconciliation** — Primary Key + Linking Key matching (Phase 1) maps entities across sources to canonical IDs (`shipit://label/namespace/name`).
- **8 MCP Tools** — Blast radius analysis, ownership lookup, dependency chains, schema introspection, entity search, and raw Cypher queries with guardrails.
- **Connector SDK** — Build custom connectors with a standardized interface: authenticate, discover, fetch, normalize, sync.
- **YAML Schema Configuration** — Define your service model, node types, relationships, and resolution strategies in a single YAML file.

## Quick Start

### Prerequisites

- Node.js 22+
- pnpm 10+
- Docker & Docker Compose

### Setup

```bash
# Clone the repo
git clone https://github.com/ship-it-ops/ShipIt-AI.git
cd ShipIt-AI

# Copy environment config
cp .env.example .env

# Start infrastructure (Neo4j + Redis)
docker compose -f docker/docker-compose.yml up -d neo4j redis

# Install dependencies and build
pnpm install
pnpm turbo build

# Run tests (221 tests across 8 packages)
pnpm turbo test
```

See [docs/getting-started.md](docs/getting-started.md) for the full setup guide including GitHub connector configuration, demo data seeding, and MCP integration.

## Project Structure

```
ShipIt-AI/
├── packages/
│   ├── shared/              # Types, schemas, identity utils, canonical data model
│   ├── event-bus/           # BullMQ/Redis event bus with replay support
│   ├── core-writer/         # Sole Neo4j writer — claim resolution, identity matching
│   ├── connector-sdk/       # Connector interface, harness, sync state machine, dry-run
│   ├── connectors/
│   │   ├── github/          # GitHub App/PAT connector (repos, teams, pipelines, CODEOWNERS)
│   │   └── kubernetes/      # Kubernetes connector (planned)
│   ├── api-server/          # Fastify REST API — connectors, schema, graph queries
│   ├── mcp-server/          # Model Context Protocol server — 8 tools for AI agents
│   └── web-ui/              # Next.js 14 dashboard with Cytoscape.js graph visualization
├── docker/                  # Docker Compose, Dockerfiles, Neo4j init scripts
├── designDocs/              # Design document and Architecture Decision Records
└── docs/                    # User-facing documentation
```

## MCP Tools

ShipIt-AI exposes the knowledge graph to AI agents via the [Model Context Protocol](https://modelcontextprotocol.io/).

| Tool               | Description                                         |
| ------------------ | --------------------------------------------------- |
| `blast_radius`     | Analyze downstream/upstream impact of a node        |
| `entity_detail`    | Get properties, claims, and neighbors for an entity |
| `find_owners`      | Find owners, code owners, and on-call for an entity |
| `dependency_chain` | Find shortest dependency path between two entities  |
| `search_entities`  | Search and filter entities by label and properties  |
| `graph_stats`      | Aggregate statistics — node/edge counts, freshness  |
| `schema_info`      | Return the current graph schema definition          |
| `graph_query`      | Execute read-only Cypher with guardrails            |

See [docs/mcp-tools.md](docs/mcp-tools.md) for full parameter reference and usage examples.

## API Endpoints

| Method   | Path                          | Description               |
| -------- | ----------------------------- | ------------------------- |
| `GET`    | `/api/health`                 | Health check              |
| `GET`    | `/api/connectors`             | List connectors           |
| `POST`   | `/api/connectors`             | Register a connector      |
| `GET`    | `/api/connectors/:id`         | Get connector details     |
| `POST`   | `/api/connectors/:id/sync`    | Trigger sync              |
| `GET`    | `/api/connectors/:id/status`  | Get sync status           |
| `DELETE` | `/api/connectors/:id`         | Remove a connector        |
| `GET`    | `/api/schema`                 | Get current schema        |
| `PUT`    | `/api/schema`                 | Update schema (YAML)      |
| `POST`   | `/api/schema/validate`        | Validate schema           |
| `GET`    | `/api/graph/stats`            | Graph statistics          |
| `GET`    | `/api/graph/neighborhood/:id` | Get neighborhood subgraph |
| `GET`    | `/api/graph/search`           | Search entities           |

See [docs/api-reference.md](docs/api-reference.md) for request/response examples.

## Schema & Ontology

ShipIt-AI uses a **Four-Node Service Model** at its core:

```
LogicalService ──IMPLEMENTED_BY──▶ Repository
       │                               │
       │                          BUILT_FROM
  DEPLOYED_AS                          │
       │                        BuildArtifact
       ▼                               │
  Deployment ────RUNS_IMAGE───────────┘
       │
  EMITS_TELEMETRY_AS
       │
       ▼
  RuntimeService
```

The schema defines **12 node types** (LogicalService, Repository, Deployment, RuntimeService, Team, Person, and more) and **16+ relationship types** — all configurable via YAML.

See [docs/schema-guide.md](docs/schema-guide.md) for the full schema reference.

## Connectors

| Connector  | Status             | Entities                                       |
| ---------- | ------------------ | ---------------------------------------------- |
| GitHub     | Available          | Repository, Team, Person, Pipeline, CODEOWNERS |
| Kubernetes | Planned (Phase 1b) | Deployment, Namespace, Cluster                 |

See [docs/connectors.md](docs/connectors.md) for setup guides and the custom connector SDK.

## Development

| Command                   | Description                 |
| ------------------------- | --------------------------- |
| `pnpm turbo build`        | Build all packages          |
| `pnpm turbo test`         | Run all tests (221 tests)   |
| `pnpm turbo test --force` | Run tests bypassing cache   |
| `pnpm turbo dev`          | Watch mode for all packages |
| `pnpm turbo lint`         | Lint all packages           |
| `pnpm turbo typecheck`    | Type-check all packages     |
| `pnpm turbo clean`        | Clean all build artifacts   |

## Docker Deployment

```bash
# Full stack
docker compose -f docker/docker-compose.yml up -d

# Services: neo4j (7474/7687), redis (6379), api-server (3001),
#           core-writer, mcp-server, web-ui (3000)
```

See [docs/deployment.md](docs/deployment.md) for environment variables, resource requirements, and production notes.

## Architecture Decision Records

| ADR                                                               | Title                                  |
| ----------------------------------------------------------------- | -------------------------------------- |
| [ADR-001](designDocs/ADRs/ADR-001-api-server-language.md)         | All-TypeScript Stack                   |
| [ADR-002](designDocs/ADRs/ADR-002-propertyclaim-storage.md)       | PropertyClaim Storage as JSON on Nodes |
| [ADR-003](designDocs/ADRs/ADR-003-phase1-mvp-scope.md)            | Phase 1 MVP Scope                      |
| [ADR-004](designDocs/ADRs/ADR-004-event-bus-strategy.md)          | Tiered Event Bus (BullMQ → Kafka)      |
| [ADR-005](designDocs/ADRs/ADR-005-defer-vector-db.md)             | Defer Vector DB to Phase 2             |
| [ADR-006](designDocs/ADRs/ADR-006-schema-configuration.md)        | YAML Schema Configuration              |
| [ADR-007](designDocs/ADRs/ADR-007-neo4j-ha-strategy.md)           | Neo4j High Availability Strategy       |
| [ADR-008](designDocs/ADRs/ADR-008-mcp-response-envelope.md)       | MCP Response Envelope Standard         |
| [ADR-009](designDocs/ADRs/ADR-009-schema-storage.md)              | Schema Storage in Neo4j                |
| [ADR-010](designDocs/ADRs/ADR-010-identity-resolution-phasing.md) | Identity Resolution Phasing            |
| [ADR-011](designDocs/ADRs/ADR-011-service-model-simple-mode.md)   | Service Model Simple Mode              |
| [ADR-012](designDocs/ADRs/ADR-012-accessibility-standards.md)     | Accessibility Standards                |

## Roadmap

### Phase 1b (Weeks 5-8)

- Kubernetes connector (Watch API + hourly reconciliation)
- Additional MCP tools: `recent_changes`, `health_check`, `list_violations`, `change_impact`, `team_topology`
- Onboarding wizard (7-step first-run flow)
- Acceptance test suite with reference graph fixtures

### Phase 2

- Fuzzy identity matching
- Vector DB integration for semantic search
- Visual schema editor
- Kafka/Redpanda event bus for production scale

## License

TBD
