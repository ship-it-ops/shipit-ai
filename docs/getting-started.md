# Getting Started

This guide walks you through setting up ShipIt-AI for local development.

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
cp .env.example .env
```

Edit `.env` with your settings. The defaults work for local development:

```bash
# Infrastructure
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=neo4j
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=shipit-dev
NEO4J_DATABASE=neo4j
REDIS_URL=redis://localhost:6379

# API Server
API_SERVER_PORT=3001
SCHEMA_PATH=./shipit-schema.yaml

# Web UI
NEXT_PUBLIC_API_URL=http://localhost:3001
```

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

ShipIt-AI supports two authentication methods for GitHub:

### GitHub App (recommended)

1. Create a GitHub App with read access to repositories, organization members, and actions
2. Install the app on your organization
3. Set environment variables:

```bash
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=/path/to/private-key.pem
GITHUB_APP_INSTALLATION_ID=789012
GITHUB_ORG=your-org
```

### Personal Access Token

```bash
GITHUB_TOKEN=ghp_xxxxxxxxxxxx
GITHUB_ORG=your-org
```

The token needs `repo`, `read:org`, and `actions:read` scopes.

### Register and Sync

```bash
# Register the connector
curl -X POST http://localhost:3001/api/connectors \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "github-main",
    "type": "github",
    "name": "GitHub - My Org",
    "config": { "org": "your-org" },
    "enabled": true
  }'

# Trigger a full sync
curl -X POST http://localhost:3001/api/connectors/github-main/sync \
  -H 'Content-Type: application/json' \
  -d '{ "mode": "full" }'

# Check sync status
curl http://localhost:3001/api/connectors/github-main/status
```

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

- [Schema Guide](schema-guide.md) — customize node types and resolution strategies
- [Connectors](connectors.md) — configure connectors or build your own
- [MCP Tools](mcp-tools.md) — full tool reference for AI integration
- [Architecture](architecture.md) — understand the system design
