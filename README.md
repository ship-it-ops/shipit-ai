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

# Bootstrap local config (also runs as part of `pnpm setup`/`pnpm start:all`)
pnpm preflight

# Start infrastructure (Neo4j + Redis)
docker compose -f docker/docker-compose.yml up -d neo4j redis

# Install dependencies and build
pnpm install
pnpm turbo build

# Run tests (221 tests across 8 packages)
pnpm turbo test
```

See [docs/getting-started.md](docs/getting-started.md) for the 5-minute quick-start, or [docs/local-development.md](docs/local-development.md) for the full day-to-day development guide (config layering, testing, webhooks-for-local-dev, debugging, code quality).

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
├── designDocs/              # Design documents (vision, scope)
└── docs/                    # User-facing documentation + Architecture Decision Records
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

Full guide: [docs/local-development.md](docs/local-development.md).

| Command                   | Description                         |
| ------------------------- | ----------------------------------- |
| `pnpm start:all`          | Boot infra + every dev server       |
| `pnpm start:backend`      | Infra + api-server + core-writer    |
| `pnpm start:frontend`     | Web UI only                         |
| `pnpm turbo build`        | Build all packages                  |
| `pnpm turbo test`         | Run all tests                       |
| `pnpm turbo test --force` | Run tests bypassing the Turbo cache |
| `pnpm turbo dev`          | Watch mode for all packages         |
| `pnpm turbo lint`         | Lint all packages                   |
| `pnpm turbo typecheck`    | Type-check all packages             |
| `pnpm turbo clean`        | Clean all build artifacts           |

## Docker Deployment

```bash
# Full stack
docker compose -f docker/docker-compose.yml up -d

# Services: neo4j (7474/7687), redis (6379), api-server (3001),
#           core-writer, mcp-server, web-ui (3000)
```

See [docs/deployment.md](docs/deployment.md) for environment variables, resource requirements, and production notes.

## Architecture Decision Records

ADRs capture the architectural decisions behind the codebase and the trade-offs accepted with each. The full index lives at [`docs/adrs/`](docs/adrs/).

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
