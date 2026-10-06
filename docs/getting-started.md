# Getting Started

This is the "just get it running" path. For the full development guide —
config layering, Postgres and agents, daily commands, testing, debugging,
webhooks, and code quality — see [local-development.md](./local-development.md).

## Prerequisites

| Tool           | Version | Install                                                                |
| -------------- | ------- | ---------------------------------------------------------------------- |
| Node.js        | 22+     | [nodejs.org](https://nodejs.org/)                                      |
| pnpm           | 10+     | `corepack enable` (installs the version pinned in `package.json`)      |
| Docker         | 20+     | [docker.com](https://www.docker.com/)                                  |
| Docker Compose | v2+     | Included with Docker Desktop                                           |
| gcloud CLI     | any     | Only for the optional AI agents and knowledge layer (Vertex AI access) |

## 1. Clone and Configure

```bash
git clone https://github.com/ship-it-ops/ShipIt-AI.git
cd ShipIt-AI
pnpm preflight
```

`preflight` checks the prerequisites and creates `shipit.config.local.yaml`
from the committed example. It is idempotent and also runs inside every
`pnpm start:*` script.

Configuration is two YAML files:

- **`shipit.config.yaml`** — committed, the production base. Defaults plus
  `${ENV_VAR}` and `${ENV_VAR:-default}` placeholders for anything that varies
  per environment or is a secret. Sign-in is **on** here, with no provider and
  no admins, so a deployment that forgets to configure auth fails loud instead
  of opening up.
- **`shipit.config.local.yaml`** — gitignored, merged on top of the base. The
  example points every service at the docker-compose Neo4j, Redis and
  Postgres, switches sign-in **off** (`accessControl.auth.enabled: false`) and
  defines the `frontend.devUser` the API server treats every request as.

Every backend service (api-server, core-writer, mcp-server, agent-runner,
knowledge-worker) reads both files, so nothing else needs an env var for a
local run.

## 2. Install and Build

```bash
pnpm install
pnpm turbo build
```

Turborepo builds the packages in dependency order (`shared` first, then the
event bus, SDK, connectors and services; the web UI last).

## 3. Start the Stack

```bash
pnpm start:all
```

This starts Neo4j, Redis and Postgres in Docker, waits for them, creates the
pgvector extension and applies the SQL migrations in `db/migrations/`, then
runs every dev server in watch mode:

| Service      | URL / port                              | Notes                                               |
| ------------ | --------------------------------------- | --------------------------------------------------- |
| Web UI       | <http://localhost:3000>                 | Next.js                                             |
| API server   | <http://localhost:3001>                 | Fastify; health at `/api/health`                    |
| MCP server   | `http://localhost:3002/mcp`             | Streamable HTTP; `/health` without a token          |
| core-writer  | —                                       | Queue worker; the only process that writes to Neo4j |
| agent-runner | —                                       | Idles until Vertex AI credentials are present (§8)  |
| Neo4j        | <http://localhost:7474>, `bolt://:7687` | Browser login `neo4j` / `shipit-dev`                |
| Redis        | `redis://localhost:6379`                | Queues, run history                                 |
| Postgres     | `postgres://localhost:5432/shipit`      | Agents and knowledge; login `shipit` / `shipit-dev` |

`pnpm start:backend` and `pnpm start:frontend` start the two halves
separately; `pnpm stop` brings the Docker services down and `pnpm stop:clean`
also deletes their volumes.

To run everything as containers instead, use the compose file (see
[deployment.md](./deployment.md)):

```bash
docker compose -f docker/docker-compose.yml up -d
```

## 4. Open the Web UI

Open <http://localhost:3000>. On the first visit a dev-only modal asks for your
name, email and team and writes them to `shipit.config.local.yaml` under
`frontend.devUser`; it also offers to seed a demo graph so the pages are not
empty. Both can be redone later (`pnpm seed`, `pnpm seed:reset`).

The sidebar is the map of the product: **Explore** (graph explorer, query
playground), **AI** (MCP access; the Ask and agent pages are previews for
now), **Catalog** (entities, team dashboard), **Configure** (Connector Hub,
schema editor), **Operations** (incident mode, claims, reconciliation) and
**Admin** (audit log, access control, settings).

## 5. Run the Tests

```bash
pnpm turbo test            # every package
pnpm turbo test --force    # bypass the Turbo cache
pnpm turbo test:watch      # watch mode
```

Integration suites that need a real database are described in
[local-development.md §7](./local-development.md#7-testing).

## 6. Connect a GitHub Org

ShipIt-AI reads repositories, teams, members, workflows and CODEOWNERS through
a **GitHub App**, one connector per org. The Connector Hub creates the App for
you through GitHub's manifest flow, so there is nothing to paste from GitHub's
settings pages:

1. Open **Configure → Connector Hub**, click **Add connector → GitHub**.
2. **App step:** enter the org login and click **Create App on GitHub**.
   GitHub shows a pre-filled registration form; confirm it, and the wizard
   picks up the App ID and private key when you return.
3. **Connect step:** install the App on the org (the wizard links to the
   install page), then pick the installation from the list.
4. **Configure step:** confirm the connector name and the repo/team scope.
5. **Review → Create + sync.** The first full sync starts immediately; the
   connector card shows its runs.

The full runbook, including the manual App path, per-org Apps, rotation and
troubleshooting, is [connectors/github-setup.md](./connectors/github-setup.md).
Webhooks keep the graph fresh between polls; for local development relay them
with smee.io as described in
[local-development.md §10](./local-development.md#10-webhooks-for-local-development).

The same can be done over the API once an App is configured:

```bash
# Validate credentials and list a sample of accessible repos
curl -X POST http://localhost:3001/api/connectors/probe \
  -H 'Content-Type: application/json' \
  -d '{"installationId": "789012"}'

# Create the connector
curl -X POST http://localhost:3001/api/connectors \
  -H 'Content-Type: application/json' \
  -d '{"id": "github-acme", "type": "github", "name": "Acme Corp",
       "installationId": "789012", "org": "acme-corp", "enabled": true}'

# Trigger a full sync
curl -X POST http://localhost:3001/api/connectors/github-acme/sync \
  -H 'Content-Type: application/json' -d '{"mode": "full"}'
```

## 7. Connect a Kubernetes Cluster (optional)

**Connector Hub → Add connector → Kubernetes** takes a cluster name and one of
three access modes (in-cluster, kubeconfig, or server + ServiceAccount token),
probes the cluster read-only, and polls it every five minutes. Workloads link
to the services and repositories the GitHub connector already found. The
reference, including the read-only RBAC to grant, is in
[connectors.md](./connectors.md#kubernetes-connector).

## 8. Verify the Graph

In the UI, **Catalog → Entities** lists what the connectors produced and
**Explore → Graph Explorer** draws it. In Neo4j Browser
(<http://localhost:7474>):

```cypher
// Count all nodes
MATCH (n) RETURN labels(n)[0] AS label, count(n) AS count ORDER BY count DESC;

// View a service and its relationships
MATCH (s:LogicalService)-[r]-(n) RETURN s, r, n LIMIT 50;
```

## 9. Connect an AI Client

The MCP server offers 8 read-only tools. Two ways in:

- **Streamable HTTP (deployed instances).** `https://<your-domain>/mcp` with a
  personal access token from **Settings → API Keys** in the `Authorization`
  header (minted by an administrator: the `member` role cannot mint the
  `mcp:invoke` scope today). Tokens exist where sign-in is enabled, so this
  is the path for a deployed instance. The [Claude Code plugin](../plugin/README.md) packages the
  registration plus three skills.
- **stdio (local).** Let the client spawn the server from your checkout; it
  reads the same config files, so no credentials go into the client config.

```json
{
  "mcpServers": {
    "shipit-ai": {
      "command": "node",
      "args": ["/path/to/ShipIt-AI/packages/mcp-server/dist/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "SHIPIT_CONFIG": "/path/to/ShipIt-AI/shipit.config.yaml"
      }
    }
  }
}
```

That block works in Claude Code's `.mcp.json` and in Claude Desktop's
`claude_desktop_config.json`. Then ask: "What services are in the graph?" or
"What is the blast radius of config-service?" The full reference, including
the HTTP snippets, is [mcp-tools.md](./mcp-tools.md).

## 10. AI Agents and the Knowledge Layer (optional)

Both run models on Vertex AI and need Google Cloud credentials:

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=<your project>   # or ai.vertex.project in the local config
```

With that, `pnpm start:backend` runs the agent-runner and the API creates a
built-in **Graph assistant** on first boot; the knowledge worker indexes the
GitHub text facet (pull requests, issues, Markdown docs) of the repositories
you select. Both are walked through in
[local-development.md §5](./local-development.md#5-running-the-stack).

## Next Steps

- [Local Development](local-development.md) — config layering, day-to-day
  commands, Postgres and agents, testing, debugging, webhooks for local dev
- [GitHub setup](connectors/github-setup.md) — the App runbook
- [Connectors](connectors.md) — connector reference + SDK for new sources
- [Schema Guide](schema-guide.md) — customize node types and resolution strategies
- [MCP Tools](mcp-tools.md) — full tool reference for AI integration
- [Architecture](architecture.md) — understand the system design
- [Deployment](deployment.md) — Docker Compose and the GKE deployment
