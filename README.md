# ShipIt-AI

**AI-Ready Knowledge Graph Builder for Software Ecosystems**

## What is ShipIt-AI?

ShipIt-AI discovers, maps, and maintains your software ecosystem as a queryable Neo4j knowledge graph. Connectors pull data from GitHub and Kubernetes, normalizing it into a unified service model where every fact is a PropertyClaim with a source, a confidence and a timestamp. The graph is exposed to people through a web UI and to AI through MCP tools and in-app agents, so questions about ownership, blast radius and dependencies get answered from live data — without manual catalog maintenance.

## Architecture

```
┌──────────────┐  ┌─────────────┐
│   GitHub     │  │ Kubernetes  │      connectors (Connector SDK)
│  Connector   │  │  Connector  │
└──────┬───────┘  └──────┬──────┘
       │   CanonicalEntities + PropertyClaims
       └────────┬────────┘
        ┌───────▼─────────┐
        │ Event Bus       │  BullMQ on Redis
        └───────┬─────────┘
        ┌───────▼─────────┐
        │  Core Writer    │  sole graph writer: identity matching,
        │                 │  claim resolution, per-field confidence
        └───────┬─────────┘
        ┌───────▼─────────┐          ┌──────────────────────────┐
        │     Neo4j 5     │          │ Postgres 17 + pgvector   │
        │ knowledge graph │          │ agents · knowledge docs  │
        └──┬─────┬─────┬──┘          └────────┬─────────────────┘
           │     │     │                      │
  ┌────────▼┐ ┌──▼─────────┐ ┌────▼───────┐ ┌─▼────────────────────────┐
  │   MCP   │ │ API Server │ │   Web UI   │ │ agent-runner ·           │
  │ Server  │ │ (Fastify)  │ │ (Next.js)  │ │ knowledge-worker (Vertex)│
  └─────────┘ └────────────┘ └────────────┘ └──────────────────────────┘
```

See [docs/architecture.md](docs/architecture.md) for the data flow, the service model and each service's role.

## Key Features

- **PropertyClaim system** — Every fact carries source, confidence and timestamp. Multiple sources can assert different values; five resolution strategies (`HIGHEST_CONFIDENCE`, `MANUAL_OVERRIDE_FIRST`, `AUTHORITATIVE_ORDER`, `LATEST_TIMESTAMP`, `MERGE_SET`) pick the effective value, and a per-field confidence engine marks each value corroborated, disputed, stale or user-verified.
- **Identity reconciliation** — Primary-key and linking-key matching maps entities across sources to canonical IDs (`shipit://label/namespace/org/name`), with a review queue for ambiguous candidates.
- **GitHub and Kubernetes connectors** — A GitHub App per org (created from the UI via GitHub's manifest flow) syncs repositories, teams, people, pipelines and CODEOWNERS by polling and by webhook; the Kubernetes connector reads a cluster's workloads, namespaces and images and links them to the services and repositories GitHub found.
- **8 MCP tools** — Blast radius, ownership, dependency chains, entity search and detail, schema and graph statistics, and raw read-only Cypher with guardrails, over Streamable HTTP with per-user tokens or over stdio. A [Claude Code plugin](plugin/README.md) ships the server registration and three skills.
- **AI agents and the knowledge layer** — User-defined agents run on Vertex AI with the graph tools (backend, runner and API shipped; the AI pages in the UI are previews until the builder lands). Knowledge connectors index text — first the GitHub text facet: pull requests, issues and Markdown docs — into Postgres/pgvector, kept apart from the graph until a person accepts a suggestion.
- **Web UI** — Graph explorer, catalog with team dashboards, incident mode, claim and reconciliation review, a schema editor with history and rollback, the Connector Hub, and admin pages for access control, settings and the audit log.
- **Sign-in and access model** — OIDC or GitHub OAuth, an admin list and an optional allow-list, admin/member roles with capabilities, Redis-backed sessions, and personal access tokens for MCP clients.
- **YAML schema** — Node types, relationship types and resolution strategies live in one YAML file with optimistic locking, a version history and a migration preview.
- **Connector SDK** — Build custom connectors against a standard interface: authenticate, discover, fetch, normalize, sync — plus a dry-run harness.

## Quick Start

### Prerequisites

- Node.js 22+
- pnpm 10+ (`corepack enable` installs the pinned version)
- Docker & Docker Compose v2

### Setup

```bash
# Clone the repo
git clone https://github.com/ship-it-ops/ShipIt-AI.git
cd ShipIt-AI

# Check prerequisites and bootstrap shipit.config.local.yaml from the example
pnpm preflight

# Install dependencies and build
pnpm install
pnpm turbo build

# Start Neo4j, Redis and Postgres in Docker, migrate, then run every dev server
pnpm start:all
```

Open <http://localhost:3000>. The first visit offers to seed demo data; the Connector Hub (**Configure → Connector Hub**) is where you add a real GitHub org or Kubernetes cluster.

See [docs/getting-started.md](docs/getting-started.md) for the guided first run, or [docs/local-development.md](docs/local-development.md) for the full day-to-day development guide (config layering, Postgres and agents, testing, webhooks for local dev, debugging, code quality).

## Project Structure

```
ShipIt-AI/
├── packages/
│   ├── shared/              # Types, config loader, schema, canonical IDs, claims, auth context, Cypher read-only check
│   ├── event-bus/           # BullMQ/Redis event bus
│   ├── core-writer/         # Sole Neo4j writer — identity matching, claim resolution, absence sweep
│   ├── connector-sdk/       # Connector interface, harness, sync state machine, dry-run, knowledge facets
│   ├── connectors/
│   │   ├── github/          # GitHub App connector (repos, teams, people, pipelines, CODEOWNERS, webhooks, text facet)
│   │   └── kubernetes/      # Kubernetes connector (clusters, namespaces, workloads, images; polling)
│   ├── api-server/          # Fastify REST API — auth, connectors, schema, graph, claims, agents, knowledge, webhooks
│   ├── mcp-server/          # Model Context Protocol server — 8 tools, HTTP (token) and stdio transports
│   ├── agents/              # Agent definitions, runs and the Postgres migrations CLI
│   ├── agent-runner/        # Works agent runs: Vertex AI models + the graph tools
│   ├── knowledge/           # Knowledge documents, chunks and embeddings in Postgres/pgvector
│   ├── knowledge-worker/    # Chunks and embeds pending documents
│   └── web-ui/              # Next.js 16 / React 19 dashboard on the @ship-it-ui design system
├── plugin/                  # Claude Code plugin: MCP registration + skills
├── config/                  # shipit-schema.yaml — the default graph schema
├── db/migrations/           # Forward-only SQL for the Postgres schema
├── docker/                  # Docker Compose, Neo4j and Postgres init
├── scripts/                 # preflight, infra, seed, reset
└── docs/                    # User-facing documentation, ADRs, design specs and the agent context (docs/agent)
```

Configuration is two YAML files: the committed `shipit.config.yaml` (defaults plus `${ENV_VAR}` placeholders) and a gitignored `shipit.config.local.yaml` merged on top of it. Every backend service reads them.

## MCP Tools

ShipIt-AI exposes the knowledge graph to AI agents via the [Model Context Protocol](https://modelcontextprotocol.io/).

| Tool               | Description                                                       |
| ------------------ | ----------------------------------------------------------------- |
| `blast_radius`     | Analyze downstream/upstream impact of a node                      |
| `entity_detail`    | Get properties, claims, and neighbors for an entity               |
| `find_owners`      | Find owners, code owners, and on-call for an entity               |
| `dependency_chain` | Find shortest dependency path between two entities                |
| `search_entities`  | Search and filter entities by label and properties                |
| `graph_stats`      | Aggregate statistics — node/edge counts, freshness                |
| `schema_info`      | Return the current graph schema definition                        |
| `graph_query`      | Execute read-only Cypher with guardrails (administrators' tokens) |

The server listens on `http://localhost:3002/mcp` and requires a personal access token (Settings → API Keys) on every request; a stdio mode is available for clients that spawn the server themselves. In-app agents get the first seven tools. See [docs/mcp-tools.md](docs/mcp-tools.md) for the connection snippets and the full parameter reference.

## API

The API server listens on `http://localhost:3001`. Route groups:

| Prefix                                                                       | What it covers                                                                 |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `/api/health`, `/api/setup`, `/api/auth`, `/api/tokens`                      | Liveness, first-boot setup, sign-in flows, personal access tokens              |
| `/api/connectors`                                                            | Connector CRUD, probe, sync, run history, credentials, knowledge containers    |
| `/api/schema`                                                                | Schema read/write, validate, diff, migration preview, history, rollback        |
| `/api/graph`, `/api/query`                                                   | Stats, neighborhood, search; raw read-only Cypher (administrators)             |
| `/api/claims`, `/api/conflicts`, `/api/relations`                            | PropertyClaim inspection, manual edits, verification, conflicts, relations     |
| `/api/teams`, `/api/reconciliation`, `/api/incident-events`                  | Team detail, identity review queue, incident-mode view log                     |
| `/api/agents`, `/api/runs`, `/api/ai`                                        | Agent definitions, runs and their event streams, model catalog and status      |
| `/api/knowledge`                                                             | Knowledge layer status                                                         |
| `/api/settings`, `/api/config`, `/api/feedback`, `/api/mcp`, `/api/webhooks` | Portal settings, config export, feedback widget, MCP metadata, GitHub webhooks |

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

The default schema defines **12 node types** (LogicalService, Repository, Deployment, RuntimeService, Team, Person, and more) and **18 relationship types** — all configurable via YAML, and editable in the UI under **Configure → Schema Editor**.

See [docs/schema-guide.md](docs/schema-guide.md) for the full schema reference.

## Connectors

| Connector  | Status    | Entities                                                                                                                                |
| ---------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub     | Available | Repository, Team, Person, Pipeline, CODEOWNERS; webhooks keep it fresh between polls; the text facet indexes PRs, issues and docs       |
| Kubernetes | Available | Cluster, Namespace, Environment, Deployment (Deployment/StatefulSet/DaemonSet/CronJob), BuildArtifact, LogicalService; absence tracking |

See [docs/connectors.md](docs/connectors.md) for the reference and the custom connector SDK, and [docs/connectors/github-setup.md](docs/connectors/github-setup.md) for the GitHub App runbook.

## Development

Full guide: [docs/local-development.md](docs/local-development.md).

| Command                    | Description                                                    |
| -------------------------- | -------------------------------------------------------------- |
| `pnpm start:all`           | Infra (Neo4j, Redis, Postgres) + migrations + every dev server |
| `pnpm start:backend`       | Infra + api-server, core-writer, mcp-server, agent-runner      |
| `pnpm start:frontend`      | Web UI only                                                    |
| `pnpm stop` / `stop:clean` | Stop the Docker services / also delete their volumes           |
| `pnpm turbo build`         | Build all packages                                             |
| `pnpm turbo test`          | Run all tests (`--force` bypasses the Turbo cache)             |
| `pnpm turbo dev`           | Watch mode for all packages                                    |
| `pnpm turbo lint`          | Lint all packages                                              |
| `pnpm turbo typecheck`     | Type-check all packages                                        |
| `pnpm format`              | Prettier over the repo                                         |

## Deployment

`docker/docker-compose.yml` runs the whole stack — Neo4j (7474/7687), Redis (6379), Postgres (5432), a one-shot `migrate`, api-server (3001), core-writer, mcp-server (3002), web-ui (3000), and behind profiles the `agent-runner` and `knowledge-worker`, which need Google Cloud credentials.

```bash
docker compose -f docker/docker-compose.yml up -d
```

The hosted demo runs on GKE: the private `shipit-ai-infra` repository builds the images and deploys them with Helm, secrets live in Google Secret Manager, and a fresh instance boots into a setup mode that walks the first administrator through sign-in and the GitHub App. See [docs/deployment.md](docs/deployment.md).

## Documentation

- [Getting started](docs/getting-started.md) · [Local development](docs/local-development.md) · [Architecture](docs/architecture.md)
- [Connectors](docs/connectors.md) · [GitHub App setup](docs/connectors/github-setup.md) · [Schema guide](docs/schema-guide.md)
- [MCP tools](docs/mcp-tools.md) · [API reference](docs/api-reference.md) · [Deployment](docs/deployment.md)
- [Architecture Decision Records](docs/adrs/) — 36 ADRs with the context and trade-offs behind the design
- [Security policy](SECURITY.md) — how to report a vulnerability
- `docs/agent/` — the committed hand-off layer for AI coding agents: decisions, plans, in-flight status, scars

## What's Next

In-flight plans live under [`docs/agent/plans/`](docs/agent/plans/). The next items:

- **Knowledge layer** — the first release behind `knowledge.enabled`, then more sources (Slack, Confluence, Jira) and graph suggestions from indexed text.
- **AI agents UI** — the agent builder, workflows and activity pages (the backend, runner and API are in).
- **Kubernetes connector** — Watch API streaming and Argo CD / Flux link signals.
- **Identity** — fuzzy matching for entities that exact keys cannot link.

## License

This project is licensed under the [Elastic License 2.0](LICENSE) (ELv2).

You may use, copy, modify, and redistribute the software, but you **may not**
provide it to third parties as a hosted or managed service that gives users
access to a substantial set of its features, and you may not circumvent any
license-key functionality or remove licensing notices. See the [LICENSE](LICENSE)
file for the full terms.
