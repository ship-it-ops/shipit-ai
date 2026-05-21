# Getting Started

This is the 5-minute "just get it running" path. For the full
development guide — config layering, daily commands, testing, debugging,
webhooks, and code quality — see
[local-development.md](./local-development.md).

## Prerequisites

| Tool           | Version | Install                                      |
| -------------- | ------- | -------------------------------------------- |
| Node.js        | 22+     | [nodejs.org](https://nodejs.org/)            |
| pnpm           | 10+     | `npm install -g pnpm` or `brew install pnpm` |
| Docker         | 20+     | [docker.com](https://www.docker.com/)        |
| Docker Compose | v2+     | Included with Docker Desktop                 |

## 1. Clone and Configure

```bash
git clone https://github.com/ship-it-ops/ShipIt-AI.git
cd ShipIt-AI
pnpm preflight
```

`preflight` checks prerequisites and bootstraps `shipit.config.local.yaml`
from the committed example. It also prompts for your name/email on first
run (these populate the user menu until real auth ships).

Configuration model — Backstage-style two-file YAML:

- **`shipit.config.yaml`** — committed, the production base. Hardcoded
  defaults plus `${ENV_VAR}` and `${ENV_VAR:-default}` placeholders for
  anything that varies per environment or is a secret.
- **`shipit.config.local.yaml`** — gitignored, optional per-developer
  overrides and local secrets. Merged on top of the base.

The defaults in `shipit.config.yaml` work for local development with the
docker-compose Neo4j/Redis instances. Override anything you need in your
local file — see `shipit.config.local.example.yaml` for templates.

## 2. Start Infrastructure

```bash
docker compose -f docker/docker-compose.yml up -d neo4j redis
```

Wait for Neo4j to become healthy:

```bash
docker compose -f docker/docker-compose.yml ps
```

Neo4j Browser is available at http://localhost:7474 (login with `neo4j` / `shipit-dev`).

## 3. Install and Build

```bash
pnpm install
pnpm turbo build
```

The build order is managed by Turborepo based on package dependencies:

```
shared → event-bus → core-writer, connector-sdk, api-server
                     connector-sdk → connector-github, connector-kubernetes
shared → mcp-server
web-ui (independent)
```

## 4. Run Tests

```bash
# Run all 221 tests across 8 packages
pnpm turbo test

# Bypass Turbo cache if you suspect stale results
pnpm turbo test --force

# Watch mode for active development
pnpm turbo test:watch
```

## 5. Start the Development Stack

### Option A: Docker Compose (all services)

```bash
docker compose -f docker/docker-compose.yml up -d
```

This starts Neo4j, Redis, API Server (port 3001), Core Writer, MCP Server, and Web UI (port 3000).

### Option B: Run services individually

```bash
# Terminal 1 — Infrastructure (if not already running)
docker compose -f docker/docker-compose.yml up -d neo4j redis

# Terminal 2 — API Server
cd packages/api-server && pnpm dev

# Terminal 3 — Core Writer
cd packages/core-writer && pnpm dev

# Terminal 4 — Web UI
cd packages/web-ui && pnpm dev
```

## 6. Configure the GitHub Connector

ShipIt-AI uses a **GitHub App** to read repositories, teams, members,
workflows, and CODEOWNERS. One App can serve many orgs (installation
IDs differ per org) — or you can configure a different App per org for
blast-radius isolation.

1. Create a GitHub App and install it in your org. Full walkthrough:
   [connectors/github-setup.md](./connectors/github-setup.md).
2. Set env vars before starting the API server:

```bash
export GITHUB_APP_ID=123456
export GITHUB_APP_PRIVATE_KEY_PATH=/path/to/private-key.pem
# Optional now / required when the webhook receiver lands in P1:
export GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)
```

3. Open <http://localhost:3000/connectors>, click **Connect GitHub**, and
   follow the 5-step wizard. The wizard probes the App credentials live
   against GitHub, lets you pick repo/team scope, and triggers an
   initial sync on submit.

To wire it up via API instead:

```bash
# Validate credentials and list a sample of accessible repos
curl -X POST http://localhost:3001/api/connectors/probe \
  -H 'Content-Type: application/json' \
  -d '{"installationId": "789012"}'

# Create the connector
curl -X POST http://localhost:3001/api/connectors \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "github-acme",
    "type": "github",
    "name": "Acme Corp",
    "installationId": "789012",
    "org": "acme-corp",
    "enabled": true
  }'

# Trigger a full sync (the wizard does this automatically)
curl -X POST http://localhost:3001/api/connectors/github-acme/sync \
  -H 'Content-Type: application/json' \
  -d '{"mode": "full"}'
```

To set up **webhooks for local development** (smee.io or ngrok), see
[local-development.md §10](./local-development.md#10-webhooks-for-local-development).

## 7. Verify in Neo4j Browser

Open http://localhost:7474 and run:

```cypher
// Count all nodes
MATCH (n) RETURN labels(n)[0] AS label, count(n) AS count ORDER BY count DESC;

// View a service and its relationships
MATCH (s:LogicalService)-[r]-(n) RETURN s, r, n LIMIT 50;
```

## 8. Connect MCP to Claude

### Claude Desktop

Add to your Claude Desktop MCP config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "shipit-ai": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js"],
      "cwd": "/path/to/ShipIt-AI",
      "env": {
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USER": "neo4j",
        "NEO4J_PASSWORD": "shipit-dev"
      }
    }
  }
}
```

### Claude Code

Add to `.claude/settings.json` or your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "shipit-ai": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js"],
      "cwd": "/path/to/ShipIt-AI",
      "env": {
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USER": "neo4j",
        "NEO4J_PASSWORD": "shipit-dev"
      }
    }
  }
}
```

Once connected, try asking Claude: "What services are in the graph?" or "What is the blast radius of config-service?"

## 9. Access the Web UI

Open http://localhost:3000 to view the graph visualization dashboard. The Web UI connects to the API Server at the URL configured in `NEXT_PUBLIC_API_URL`.

## Next Steps

- [Local Development](local-development.md) — config layering, day-to-day
  commands, testing, debugging, webhooks for local dev
- [GitHub setup](connectors/github-setup.md) — full App creation + install
  runbook (one-time)
- [Schema Guide](schema-guide.md) — customize node types and resolution strategies
- [Connectors](connectors.md) — connector reference + SDK for new sources
- [MCP Tools](mcp-tools.md) — full tool reference for AI integration
- [Architecture](architecture.md) — understand the system design
