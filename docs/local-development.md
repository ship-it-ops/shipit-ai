# Local Development

The canonical guide for working on ShipIt-AI day to day. For a 5-minute
"just get it running" path, see [getting-started.md](./getting-started.md).
For everything else — config layering, watch mode, testing, debugging,
webhooks, code quality — read on.

## Contents

1. [Prerequisites](#1-prerequisites)
2. [First-time setup](#2-first-time-setup)
3. [Project layout](#3-project-layout)
4. [Configuration model](#4-configuration-model)
5. [Running the stack](#5-running-the-stack)
6. [Day-to-day commands](#6-day-to-day-commands)
7. [Testing](#7-testing)
8. [Debugging](#8-debugging)
9. [Connectors](#9-connectors)
10. [Webhooks for local development](#10-webhooks-for-local-development)
11. [Schema editing](#11-schema-editing)
12. [MCP server](#12-mcp-server)
13. [Code quality](#13-code-quality)
14. [Troubleshooting](#14-troubleshooting)

---

## 1. Prerequisites

| Tool           | Version | Install                                      |
| -------------- | ------- | -------------------------------------------- |
| Node.js        | 22+     | [nodejs.org](https://nodejs.org/)            |
| pnpm           | 10+     | `npm install -g pnpm` or `brew install pnpm` |
| Docker         | 20+     | [docker.com](https://www.docker.com/)        |
| Docker Compose | v2+     | Bundled with Docker Desktop                  |

You don't need Redis or Neo4j installed locally — both run in
docker-compose. You do not need to globally install `turbo` or `tsx`;
they're workspace dependencies.

---

## 2. First-time setup

```bash
git clone https://github.com/ship-it-ops/ShipIt-AI.git
cd ShipIt-AI
pnpm preflight
pnpm install
pnpm turbo build
pnpm start:all
```

What each step does:

- **`pnpm preflight`** — checks Node/pnpm/Docker versions and bootstraps
  `shipit.config.local.yaml` from the committed example. Idempotent; safe
  to re-run.
- **`pnpm install`** — installs workspace dependencies via pnpm's
  workspace protocol. Husky's pre-commit hook is also wired up here.
- **`pnpm turbo build`** — builds every package in dependency order
  (shared → connector-sdk → connectors, event-bus, etc.).
- **`pnpm start:all`** — starts Neo4j, Redis and Postgres in Docker, waits
  for them, creates the pgvector extension and applies `db/migrations/`,
  prints a hint if the graph is empty (seeding itself is offered by the web
  UI's onboarding modal, or `pnpm seed`), then runs every dev server
  (`api-server`, `core-writer`, `mcp-server`, `agent-runner`,
  `knowledge-worker`, `web-ui`) in parallel via `turbo dev`.

Then open <http://localhost:3000>.

### The first-run wizard

A dev-mode onboarding modal appears the first time you load the UI. It
collects your name/email/team and writes them to `shipit.config.local.yaml`
under `frontend.devUser`. That identity is the **dev-fallback principal**:
with `accessControl.auth.enabled: false` (the local default) the api-server
admits every request as this user, with the capabilities listed under
`frontend.devUser.capabilities`. Production runs with sign-in on
([ADR-027](./adrs/ADR-027-login-and-access-model.md)) and ignores `devUser`;
the wizard is dev-only and production builds skip it entirely. See
[`ADR-015`](./adrs/ADR-015-first-run-dev-onboarding.md) for the design.

---

## 3. Project layout

```
ShipIt-AI/
├── packages/
│   ├── shared/              # Types, Zod schemas, config loader, identity utils, canonical model
│   ├── event-bus/           # BullMQ/Redis client (producer + consumer)
│   ├── core-writer/         # Writer of connector data to Neo4j — claim resolution, identity matching
│   ├── connector-sdk/       # ShipItConnector interface, harness, sync state, knowledge contract
│   ├── connectors/
│   │   ├── github/          # GitHub App connector (+ webhooks, text facet)
│   │   └── kubernetes/      # Kubernetes connector (polling, three access modes)
│   ├── api-server/          # Fastify REST API — /api/*, sync schedulers, webhook receiver
│   ├── mcp-server/          # MCP server (HTTP :3002 or stdio) — 8 tools for AI agents
│   ├── agents/              # Agent + run stores, Postgres migrations CLI
│   ├── agent-runner/        # Works agent runs on Vertex AI with the graph tools
│   ├── knowledge/           # Knowledge documents, chunks, embeddings (pgvector)
│   ├── knowledge-worker/    # Chunks and embeds pending documents
│   └── web-ui/              # Next.js 16 dashboard (App Router + React Query)
├── db/migrations/           # Forward-only SQL applied by `pnpm db:migrate`
├── docker/                  # Docker Compose, Neo4j + Postgres init
├── plugin/                  # Claude Code plugin (MCP registration + skills)
├── scripts/                 # preflight, infra, seed, dev helpers
├── config/                  # shipit-schema.yaml (graph schema)
├── docs/                    # User docs + ADRs + specs + docs/agent
├── shipit.config.yaml       # Committed base config
└── shipit.config.local.yaml # Per-developer overrides (gitignored)
```

Turborepo manages build order automatically; no need to remember which
package depends on what.

---

## 4. Configuration model

ShipIt-AI uses a Backstage-style **two-file layered config**
([ADR-014](./adrs/ADR-014-layered-local-configuration.md)):

| File                               | Committed? | Purpose                                          |
| ---------------------------------- | ---------- | ------------------------------------------------ |
| `shipit.config.yaml`               | yes        | Production base — defaults for every deployment  |
| `shipit.config.local.yaml`         | **no**     | Per-developer overrides + local secrets          |
| `shipit.config.local.example.yaml` | yes        | Template copied to the above by `pnpm preflight` |

The loader (`@shipit-ai/shared`'s `loadConfig()`) reads the base file,
deep-merges the local file on top, substitutes `${ENV_VAR}` and
`${ENV_VAR:-default}` placeholders, and validates the result with Zod.
Validation failures throw on boot with a precise path — fail-fast by
design.

### Top-level sections

```yaml
backend: # Services ShipIt runs: Neo4j, Redis, API, MCP, schema, etc.
secrets: # Registry of every logical secret: container name, env var, writable?
connectors: # External integrations (GitHub App identity + connector instances)
feedback: # The in-app "Report a problem" widget
ai: # Agent platform: Postgres URL, Vertex project, model catalog, limits
knowledge: # Knowledge layer: enabled switch, embedding model, sync + worker knobs
frontend: # Next.js client: api URL, devUser, integration links
accessControl: # Sign-in providers, admins, allow-list, sessions, CORS origins
```

`connectors:` is split into:

- `connectors.github.app.*` — global GitHub App identity (env-driven).
- `connectors.github.rateLimits.*` — knobs for Octokit conditional
  requests + max concurrent syncs.
- `connectors.instances[]` — per-org connector entries, written by the
  Connector Hub UI. Not normally hand-edited.

### Secrets boundary

| Where they live      | What goes there                                                        |
| -------------------- | ---------------------------------------------------------------------- |
| `process.env`        | Passwords, tokens, private-key file paths, webhook secrets             |
| `shipit.config.yaml` | Env-var placeholders (`${GITHUB_APP_ID:-}`), non-secret defaults       |
| `.local.yaml`        | Personal devUser identity, optional integration toggles, dev passwords |

Secret material **never** lands in either YAML. The `secretlint` pre-commit
hook ([ADR-017](./adrs/ADR-017-secret-scanning-with-secretlint.md)) blocks
PEMs, JWTs, GitHub tokens, AWS keys, etc. from being committed.

### Editing config from the UI

The Schema Editor (`/configure/schema`) and the Connector Hub
(`/connectors`) both write back to disk under ETag-based optimistic
concurrency ([ADR-016](./adrs/ADR-016-optimistic-concurrency-for-editable-config.md)).
If two tabs (or two people on a shared dev machine) edit the same resource
concurrently, the loser sees a 409 and a "reload and rebase" dialog.

---

## 5. Running the stack

### Recommended: scripted starts

| Script                | What it starts                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `pnpm start:infra`    | Docker: Neo4j + Redis + Postgres (pgvector), bootstraps pgvector, migrates                    |
| `pnpm start:backend`  | Infra + `api-server` + `core-writer` + `agent-runner` (seeds demo data if the graph is empty) |
| `pnpm start:frontend` | Web UI dev server only                                                                        |
| `pnpm start:mcp`      | MCP server only (HTTP on `:3002`; set `MCP_TRANSPORT=stdio` for a spawned server)             |
| `pnpm start:all`      | Everything in parallel                                                                        |
| `pnpm stop`           | Bring all docker-compose services down                                                        |
| `pnpm stop:clean`     | Down + delete volumes (wipes Neo4j, Redis and Postgres data)                                  |
| `pnpm db:migrate`     | Apply pending files in `db/migrations/` (needs `DATABASE_URL`)                                |
| `pnpm db:bootstrap`   | Create the pgvector extension as a superuser; `start:infra` runs it first                     |

### Manual paths

For surgical control:

```bash
# Terminal 1 — infra
docker compose -f docker/docker-compose.yml up -d neo4j redis postgres
DATABASE_URL=postgres://shipit:shipit-dev@localhost:5432/shipit pnpm db:bootstrap
DATABASE_URL=postgres://shipit:shipit-dev@localhost:5432/shipit pnpm db:migrate

# Terminal 2 — api-server (watch mode)
pnpm --filter @shipit-ai/api-server dev

# Terminal 3 — core-writer (watch mode)
pnpm --filter @shipit-ai/core-writer dev

# Terminal 4 — web-ui (Next.js dev server)
pnpm --filter @shipit-ai/web-ui dev

# Terminal 5 — agent-runner (watch mode; see "Running agents locally")
GOOGLE_CLOUD_PROJECT=<your project> pnpm --filter @shipit-ai/agent-runner dev
```

### Ports

| Service     | URL                                         | Notes                                          |
| ----------- | ------------------------------------------- | ---------------------------------------------- |
| Web UI      | <http://localhost:3000>                     | Next.js                                        |
| API Server  | <http://localhost:3001>                     | Fastify; OpenAPI at `/docs`                    |
| Neo4j HTTP  | <http://localhost:7474>                     | Neo4j Browser; login `neo4j`/`shipit-dev`      |
| Neo4j Bolt  | `bolt://localhost:7687`                     | driver protocol                                |
| Redis       | `redis://localhost:6379`                    | BullMQ + event bus                             |
| Postgres    | `postgres://localhost:5432/shipit`          | Agent definitions; login `shipit`/`shipit-dev` |
| Smee target | `http://localhost:3001/api/webhooks/github` | When you set up webhooks (§10)                 |

### Postgres and agent features

Agent definitions (AI → Agents) live in Postgres. It is optional: without it the
rest of the product runs as before and every `/api/agents` call answers
`503 AI_UNAVAILABLE`.

To turn it on locally, point the api-server at the compose database by adding
this to `shipit.config.local.yaml` (new checkouts get it from the example file):

```yaml
ai:
  database:
    url: postgres://shipit:shipit-dev@localhost:5432/shipit
```

`GET http://localhost:3001/api/ai/status` then reports each prerequisite.
Definitions work with the database alone; running agents also needs the
runner and a model (next section).

The schema is plain SQL in `db/migrations/`, named `NNNN_description.sql` and
forward-only: never edit a file that has been applied, add a new one. The app
does not migrate at boot. `pnpm start:infra` applies pending files locally; on
GKE the infra repo's deploy step applies the same files. When you add a
migration, bump `EXPECTED_SCHEMA_VERSION` in
`packages/agents/src/schema-version.ts` in the same change.

`pnpm start:infra` (and `start:backend`, `start:all`) always migrates the compose
database it has just started, with this checkout's `db/migrations`, whatever
`DATABASE_URL`, `DATABASE_MIGRATOR_URL`, `DATABASE_SUPERUSER_URL` or `MIGRATIONS_DIR` is
exported in your shell. To point it at another database on purpose, set
`SHIPIT_DEV_DATABASE_URL`. Run by hand, `pnpm db:migrate` uses `DATABASE_MIGRATOR_URL`
when it is set and `pnpm db:bootstrap` uses `DATABASE_SUPERUSER_URL`, each before
`DATABASE_URL`, and `pnpm db:migrate` reads `MIGRATIONS_DIR` (default `db/migrations`).

Two rules keep a migration from stalling a database that is in use. A file runs
under a 5-second lock timeout: one that cannot get its lock fails, and is tried
again later, instead of making every other query on the table wait behind it.
And a file whose first line is `-- migrate: no-transaction` runs outside a
transaction (and without that timeout), which is what `CREATE INDEX
CONCURRENTLY` needs to index a table without blocking writes to it. Such a file
holds one statement, written with `IF NOT EXISTS`. It is recorded only while
the schema holds no invalid index: a concurrent build that fails leaves one
behind, and the migrator then names it and the `DROP INDEX CONCURRENTLY` to run
before trying again.

The knowledge layer (`packages/knowledge`, `packages/knowledge-worker`) stores
documents and embeddings in the same database and needs the pgvector extension.
pgvector is not a trusted extension, so a superuser creates it once:
`pnpm db:bootstrap` locally (the compose `shipit` user is the superuser), the
infra bootstrap step on GKE. The compose `postgres` service runs a pgvector
image and creates the extension on a fresh volume; `pnpm start:infra` runs the
bootstrap before migrating so an older volume catches up. `GET /api/knowledge/status`
reports what is missing.

The layer is off in the committed `shipit.config.yaml` until its first release. To work on
it, set `knowledge: { enabled: true }` in your `shipit.config.local.yaml` (the example file
has it) and run the worker on the host, which reads that file:

```bash
GOOGLE_CLOUD_PROJECT=<project> pnpm --filter @shipit-ai/knowledge-worker dev
```

It needs Application Default Credentials (`gcloud auth application-default login`) to embed;
without a worker, documents wait as `pending`. `docker compose --profile knowledge up` runs
the same worker in a container, but that one reads the committed config and so idles until
`knowledge.enabled` is true there.

To index a GitHub connector's text, switch its knowledge facet on, list its repositories
and select the ones to index. All of it needs an admin (the local dev user is one):

```bash
API=http://localhost:3001/api/connectors/<connector-id>
curl -s -X PATCH $API -H 'content-type: application/json' -d '{"knowledge":{"enabled":true}}'
curl -s -X POST $API/containers/refresh
curl -s $API/containers | jq '.containers[] | {id, name, visibility, selected, documents}'
# A private repository needs "acknowledgeVisibility": true: its content becomes
# visible to every signed-in user.
curl -s -X PUT $API/containers/<container-id> -H 'content-type: application/json' \
  -d '{"selected":true,"acknowledgeVisibility":true}'
curl -s -X POST $API/sync -H 'content-type: application/json' -d '{"mode":"incremental"}'
```

The `PATCH` replaces the whole `knowledge` block, so send every setting you changed from
its default, not only the one you are changing now. A change to `docs.paths`,
`docs.maxFileBytes` or `historyDays` takes effect at the next poll. Deselecting a repository
(`{"selected":false}`) deletes what was indexed for it: the worker purges once a minute, so
it usually takes a minute or two. Deleting the connector does the same for everything it
holds. Selecting a repository the last listing called public asks GitHub about that
repository first, to make sure it still is. A `429 RATE_LIMITED` from the refresh or the
select means GitHub asked to wait; try again in a few minutes.

Knowledge runs have their own history: `GET $API` returns them as `lastKnowledgeRuns`,
with their notes, beside `lastRuns`, which is the graph sync alone.

Pull requests and docs need nothing new from the GitHub App. Issues need the App's
**Issues: read** permission: the App's owner adds it under the App's settings, Permissions
& events, and an owner of the organisation approves the request GitHub emails. Until then
runs succeed with the note `issues_permission_missing` in `lastKnowledgeRuns`.

If your `postgres_data` volume was created by the earlier `postgres:17-alpine` image, the
pgvector image (Debian) sorts text with a different collation library, and indexes on text
columns built under the old one can return wrong results. Either start clean
(`pnpm stop:clean`, which deletes the local database) or run `REINDEX DATABASE shipit;` once.

Run the Postgres-backed tests with the compose database up:

```bash
DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit \
  pnpm --filter @shipit-ai/agents run test:integration
```

Each suite creates and drops its own schema, so it does not touch your data.

### Running agents locally

Runs are worked by the `agent-runner` process, which calls models on Vertex AI
and runs the graph tools against your local Neo4j. Agents are offered seven of
the MCP server's eight tools: `graph_query`, which runs raw Cypher, stays with
MCP clients (the tool metadata marks it `agents: false`). The runner needs:

- **Application Default Credentials:** `gcloud auth application-default login`.
- **A Vertex project:** `GOOGLE_CLOUD_PROJECT` in the runner's environment (or
  `ai.vertex.project` in `shipit.config.local.yaml`), with the models in
  `ai.models` enabled, and given quota, in that project.
- **A local dev user that may run agents.** With auth off, the dev user's
  capabilities come from `frontend.devUser.capabilities` in
  `shipit.config.local.yaml`; use `'*'`. The example file preflight copies
  does not include it (`admin` is not a capability name, so it grants
  nothing), so a fresh checkout cannot run agents until you edit that list.

`pnpm start:backend` starts the runner with the rest of the backend. In the
Docker stack it is behind a profile, because it needs your gcloud credentials:
`docker compose -f docker/docker-compose.yml --profile agents up -d`. On its
first boot with a database, the api-server creates the built-in **Graph
assistant**. Try it from a terminal:

```bash
AGENT=$(curl -s localhost:3001/api/agents | jq -r '.items[] | select(.slug=="graph-assistant") | .id')
RUN=$(curl -s -X POST localhost:3001/api/agents/$AGENT/runs \
  -H 'content-type: application/json' \
  -d '{"input":"Which pipelines build the shipit-ai repository?","mode":"chat"}' | jq -r .id)
curl -N localhost:3001/api/runs/$RUN/stream          # live events; Ctrl-C when it waits
curl -s -X POST localhost:3001/api/runs/$RUN/messages \
  -H 'content-type: application/json' -d '{"text":"Who owns it?"}'
curl -s localhost:3001/api/runs/$RUN/messages | jq '.toolCalls[] | {toolId, status}'
```

The runner's suites need Postgres and Redis; the live model check needs ADC:

```bash
DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit REDIS_TEST_URL=redis://localhost:6379 \
  pnpm --filter @shipit-ai/agent-runner run test:integration
VERTEX_TEST_PROJECT=<your project> VERTEX_TEST_MODELS=gemini:gemini-3.8-flash \
  pnpm --filter @shipit-ai/agent-runner run test:live
```

---

## 6. Day-to-day commands

```bash
# Build everything
pnpm turbo build

# Build one package
pnpm --filter @shipit-ai/api-server build

# Watch + rebuild on change
pnpm --filter @shipit-ai/connector-github dev

# Typecheck only (no emit)
pnpm turbo typecheck

# Run all tests
pnpm turbo test

# Run one package's tests
pnpm --filter @shipit-ai/api-server test

# Watch mode for a focused TDD loop
pnpm --filter @shipit-ai/web-ui test:watch

# Force-rerun (bypass Turbo cache)
pnpm turbo test --force

# Format + lint the whole repo
pnpm format
pnpm lint:fix

# Clean derived files
pnpm turbo clean
```

`turbo` caches per-package outputs in `.turbo/`. If you suspect a stale
cache (rare), `pnpm turbo <task> --force` re-runs without using it.

---

## 7. Testing

We use **Vitest** across every package. Tests live alongside source in
`__tests__/` directories.

### Conventions

- **Unit tests** are the default. Most coverage lives here.
- **Integration tests** that need Neo4j, Redis or Postgres are gated by
  environment variables (`NEO4J_TEST_URI`, `REDIS_TEST_URL`,
  `DATABASE_TEST_URL`; `describe.skipIf`) and run by each package's
  `test:integration` script. Several of them **wipe the graph they are
  pointed at** (`MATCH (n) DETACH DELETE n`), so never aim them at the
  dev database — use a scratch Neo4j on another port.
- **No e2e browser tests** yet — the web UI tests use Vitest + React
  Testing Library against a mocked API client.

### Running with coverage

```bash
pnpm --filter @shipit-ai/api-server test --coverage
```

### Writing tests for new connector code

Mock the GitHub API at the Octokit level (the existing tests for
`packages/connectors/github/src/__tests__/` are a good model — they
construct fake responses without hitting `api.github.com`).

For API-server route tests, use `createServer({ connectorRegistry, config })`
with a fresh `ConnectorRegistry` bound to a tempfile — see
`packages/api-server/src/__tests__/routes/connectors.test.ts`.

---

## 8. Debugging

### Logs

Each dev server logs to its own terminal. The most-useful signals:

- `api-server`: Fastify access logs + structured logs from
  `SchemaService`, `ConnectorRegistry`, `SyncScheduler`.
- `core-writer`: per-event processing logs from the BullMQ worker.
- `web-ui`: Next.js + React Query DevTools (visible in the browser when
  `NODE_ENV !== 'production'`).

### Neo4j Browser

Open <http://localhost:7474>, log in with `neo4j` / `shipit-dev`. Useful
queries:

```cypher
// Node counts per label
MATCH (n) RETURN labels(n)[0] AS label, count(n) AS count ORDER BY count DESC;

// Everything around a specific entity
MATCH (n {id: "shipit://repository/default/acme-corp/payments-api"})-[r]-(m)
RETURN n, r, m LIMIT 50;

// Wipe everything (dev only!)
MATCH (n) DETACH DELETE n;
```

### Reset the graph

```bash
# Delete demo data, keep the schema
pnpm seed:reset

# Full nuke — drop Neo4j volume and restart
pnpm stop:clean
pnpm start:infra
```

### Reset connectors

Connector instances live in `shipit.config.local.yaml` under
`connectors.instances[]`. To wipe them, either:

1. Delete each from the UI (Connector Hub → connector → Settings → Delete), or
2. Edit the YAML directly: set `connectors: { instances: [] }`, then restart `api-server`.

### Inspect what's persisted

```bash
# Look at the local config
cat shipit.config.local.yaml

# Show resolved config (after env substitution + Zod validation)
pnpm --filter @shipit-ai/api-server exec node -e \
  "import('./dist/config.js').then(m => console.log(JSON.stringify(m.loadConfig(), null, 2)))"
```

---

## 9. Connectors

The Connector Hub at <http://localhost:3000/connectors> is the primary UI
for adding/managing connectors. For the **GitHub** connector, the easiest
path is the **manifest flow** — the wizard creates the App for you via
GitHub's manifest endpoint with all permissions pre-filled.

**Recommended (manifest flow):**

1. Open `/connectors`, click **Add connector** → **GitHub**.
2. In step 1 (App), keep the default **Use one shared App for all my orgs**.
3. Optionally set an "App owner" org; leave blank for personal account.
4. Click **Create App on GitHub** — new tab, click Create on GitHub's side.
5. ShipIt-AI's callback writes the PEM to `~/.shipit/keys/github-app-<id>.pem`
   (override the directory with `SHIPIT_GITHUB_APP_KEY_DIR=…`), persists the
   App ID + path into `connectors.github.app.*`, and shows you the
   webhook-secret file path.
6. `export GITHUB_WEBHOOK_SECRET=$(cat ~/.shipit/keys/github-app-<id>.webhook-secret)`,
   restart `pnpm start:backend`, return to the wizard, paste the
   Installation ID, finish.

**Manual (if you already have an App):**

1. Set env vars on the `api-server` process:
   ```bash
   export GITHUB_APP_ID=12345
   export GITHUB_APP_PRIVATE_KEY_PATH=$HOME/.shipit/github-app.pem
   export GITHUB_WEBHOOK_SECRET=$(openssl rand -hex 32)
   ```
2. Restart `pnpm start:backend` so the values flow into the scheduler.
3. Open `/connectors` → wizard step 1 → expand "I already have a GitHub App
   — paste credentials manually". The rest of the wizard runs unchanged.

Full walkthrough for both paths:
[connectors/github-setup.md](./connectors/github-setup.md).

To use a **separate App per org** (e.g. dev-app for dev orgs, prod-app for
prod orgs), expand the "Use a separate GitHub App for this org" panel in
step 1 of the wizard. See [github-setup.md §6b](./connectors/github-setup.md#6b-per-org-github-apps-the-default).

Trigger an immediate sync via the UI ("Sync now" in the connector
detail drawer) or by API:

```bash
curl -X POST http://localhost:3001/api/connectors/<id>/sync \
  -H 'Content-Type: application/json' \
  -d '{"mode": "full"}'
```

---

## 10. Webhooks for local development

GitHub posts webhooks to a publicly-reachable URL. `localhost:3001` isn't
publicly reachable, so during local development we relay deliveries
through a tunnel. We recommend **[smee.io](https://smee.io)** — free, no
account, no auth token. ngrok and Cloudflare Tunnel are valid alternatives
for teams that need authentication on the tunnel itself.

The receiver is `POST /api/webhooks/github` ([ADR-030](./adrs/ADR-030-github-webhook-receiver.md)).
It verifies every delivery's `X-Hub-Signature-256` (HMAC-SHA256 over the
raw body) against the App's webhook secret — a per-org App's secret from
`<key dir>/github-app-<appId>.webhook-secret`, the shared App's from the
secrets accessor — answers `401` on a bad signature and `202` on a good
one, and queues a **coalesced refetch**: a `push` refetches the repository,
a `workflow_run` its workflows; `ping` is acknowledged; other events are
accepted and ignored. Polling on the connector's `schedule` stays the
backstop.

An App created through the Connector Hub's manifest flow already has the
webhook URL (`GITHUB_WEBHOOK_PUBLIC_URL`, or `connectors.github.app.webhookPublicUrl`
in your local config) and a generated secret. The steps below are for
pointing that App at your machine.

### Setup with smee.io (recommended)

#### Step 1 — Pick a smee channel

Open <https://smee.io> in a browser. The page generates a fresh channel
URL like `https://smee.io/abc123XYZ`. Bookmark it. The channel is just a
relay queue; anyone with the URL can post to it, so don't reuse one
across projects.

#### Step 2 — Start the smee client

In a long-running terminal (often a dedicated tab), run:

```bash
npx smee-client \
  --url https://smee.io/abc123XYZ \
  --target http://localhost:3001/api/webhooks/github
```

You'll see `Forwarding https://smee.io/abc123XYZ to http://localhost:3001/api/webhooks/github`.
Leave this running. Each delivery posted to the smee URL is replayed to
your local API server within a second or two.

> **Tip:** if you stop the client and restart it, GitHub will redeliver
> the most recent events from the App's settings page — see step 5.

#### Step 3 — Configure the GitHub App

In GitHub → App settings → **Webhook**:

- **Active**: ✅
- **Webhook URL**: `https://smee.io/abc123XYZ` (the same one you started
  the client on)
- **Webhook secret**: the one the manifest flow generated (shown on the
  success page, stored beside the App's key), or a new one from
  `openssl rand -hex 32` — in which case give the API server the same
  value in step 4.
- **SSL verification**: Enabled

The events the manifest subscribes to are `push`, `pull_request`,
`issues`, `issue_comment`, `workflow_run`, `deployment`,
`deployment_status`, `member`, `membership`, `team`, `team_add` and
`repository`; today the receiver acts on `push` and `workflow_run` and
accepts the rest.

#### Step 4 — Make sure the API server knows the secret

For the shared (global) App, either set it from the UI — **Admin →
Settings → Webhooks** generates or rotates it with no restart — or export
it before starting the API server:

```bash
export GITHUB_WEBHOOK_SECRET=<the-secret-you-pasted-into-github>
```

A per-org App reads its own secret file next to its private key, so
nothing to export.

#### Step 5 — Verify deliveries

Trigger an event — push a commit to a repo the App is installed in.
Then check three places, in order:

1. **GitHub App's Recent Deliveries** (App settings → Advanced):
   each delivery should show a `200 OK` from smee.io. Click any
   delivery to see the payload + signature header.
2. **smee.io page** in your browser: the channel page streams every
   delivery in real time. Useful to confirm GitHub posted it.
3. **smee-client terminal**: prints each forwarded delivery and the
   HTTP status from your API server.

A `202` from the API server means the signature verified and a refetch
was queued; the connector's **Runs** tab shows it a moment later. A `401`
means the secret GitHub signed with is not the one the API server holds.

### Setup with ngrok (alternative)

If you'd rather keep deliveries off a public relay:

```bash
# One-time: sign up at ngrok.com, get an authtoken
ngrok config add-authtoken <your-token>

# Forward localhost:3001 to a public https URL
ngrok http 3001
```

ngrok prints a URL like `https://abc.ngrok-free.app`. In the GitHub App's
webhook settings, set the URL to `https://abc.ngrok-free.app/api/webhooks/github`.

Trade-offs vs smee:

- **Pro**: no third-party queue in the path; deliveries hit your machine
  directly.
- **Pro**: full HTTPS visibility into your local API in the ngrok web UI
  (<http://127.0.0.1:4040>).
- **Con**: the URL changes every time `ngrok` restarts (unless you have a
  paid plan with a reserved domain) — you'll keep re-pasting it into the
  App settings.

### Webhook signature verification

The receiver verifies each delivery's HMAC signature with a constant-time
compare against the raw request body (`packages/shared/src/auth/github-webhook.ts`).
**Both smee and ngrok preserve the `X-Hub-Signature-256` header verbatim**,
so verification works identically over either tunnel. If you see `401`s,
the most common cause is the secret in GitHub not matching the one the API
server holds (e.g. you regenerated it on one side without updating the
other) — rotate it from **Admin → Settings → Webhooks** and paste the new
value into GitHub.

### Common webhook gotchas

| Symptom                                        | Cause / fix                                                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| GitHub shows red ✗ on deliveries               | Smee or ngrok URL doesn't match the App's webhook URL — re-paste.                                           |
| smee-client says "ECONNREFUSED localhost:3001" | `api-server` isn't running. Start it with `pnpm start:backend`.                                             |
| 401 on `/api/webhooks/github`                  | The secret the API server holds differs from the App's webhook secret — rotate from Admin → Settings.       |
| Smee disconnect after long idle                | Re-run `npx smee-client …`. The smee server occasionally cycles channels.                                   |
| ngrok URL stale after restart                  | Free tier rotates the URL on each restart. Update the GitHub App settings, or pay for a reserved domain.    |
| Receiver complains "installation id not found" | The delivery's `installation.id` doesn't match any connector. Add the org via the wizard or check the YAML. |

---

## 11. Schema editing

The graph schema lives at `config/shipit-schema.yaml`. Edit it via:

- **UI**: <http://localhost:3000/configure/schema> — visual node + edge
  editor with diff, migration preview, history, and rollback.
- **API**: `PUT /api/schema` (with `If-Match` ETag header for optimistic
  concurrency).
- **Directly on disk**: works, but the API server must reload (it caches
  the parsed schema on startup).

See [schema-guide.md](./schema-guide.md) for the schema's structure and
[ADR-009](./adrs/ADR-009-schema-storage.md) for the persistence story.

---

## 12. MCP server

The MCP server exposes 8 tools to AI agents. `pnpm start:all` runs it over
Streamable HTTP on `http://localhost:3002/mcp`, but that transport requires
a personal access token on every request, and tokens can only be minted
when sign-in is on — so with the local default (sign-in off) connect a
client over **stdio** instead. Add to your MCP config (Claude Code's
`.mcp.json`, or `~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "shipit-ai": {
      "command": "node",
      "args": ["/absolute/path/to/ShipIt-AI/packages/mcp-server/dist/index.js"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "SHIPIT_CONFIG": "/absolute/path/to/ShipIt-AI/shipit.config.yaml"
      }
    }
  }
}
```

The server reads Neo4j settings from `shipit.config.yaml` and your
`shipit.config.local.yaml`; `SHIPIT_CONFIG` is needed because Claude Code
ignores `cwd`. Restart the client after editing. To exercise the HTTP path
locally, turn sign-in on in `shipit.config.local.yaml`, mint a token under
Settings → API Keys, and use the [Claude Code plugin](../plugin/README.md)
with `SHIPIT_MCP_TOKEN` set. See [mcp-tools.md](./mcp-tools.md) for the
full tool reference.

---

## 13. Code quality

### Pre-commit

`husky` + `lint-staged` runs on every commit:

1. **Prettier** formats staged `.ts/.tsx/.js/.jsx/.json/.md/.yaml/.css` files.
2. **secretlint** scans every staged file with the
   `@secretlint/secretlint-rule-preset-recommend` rule set
   ([ADR-017](./adrs/ADR-017-secret-scanning-with-secretlint.md)).

If secretlint catches a real secret, **remove it from the working tree
and rotate it** — don't just edit the commit. Anything in your commit
history is recoverable by anyone who clones the repo.

### Linting

```bash
pnpm lint           # report only
pnpm lint:fix       # auto-fix what's safe
pnpm format         # Prettier the whole repo
pnpm format:check   # CI-friendly check, no writes
```

### CI parity

CI (`.github/workflows/ci.yml`) runs seven jobs: `lint` (`pnpm format:check`,
`pnpm turbo lint`, secretlint), `typecheck`, `test` (`pnpm turbo test
--force`), `integration` (the env-gated suites against Neo4j + APOC, Redis
and a pgvector Postgres), `build`, `docker` (builds the backend images
without pushing) and `claude-review` (an automated review that posts on
non-draft pull requests). If `pnpm format:check`, `pnpm turbo lint`,
`pnpm turbo typecheck`, `pnpm turbo test --force` and `pnpm turbo build`
pass locally, the PR should be green.

---

## 14. Troubleshooting

| Symptom                                                           | Likely cause / fix                                                                                                                                                                                              |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Config validation failed` on `pnpm start:*`                      | A required env var isn't set, or `.local.yaml` has a shape mismatch. Error message points at the failing path.                                                                                                  |
| `Cannot find module '@shipit-ai/...'`                             | Build cache mismatch. Run `pnpm install && pnpm turbo build`.                                                                                                                                                   |
| Connector card stuck on `not_connected`                           | Initial sync hasn't finished — check the Runs tab in the connector drawer for the latest run's error.                                                                                                           |
| `SyncScheduler init failed: ...` at API server boot               | Either Redis isn't reachable, or the GitHub App private key file at `$GITHUB_APP_PRIVATE_KEY_PATH` is missing.                                                                                                  |
| Neo4j browser login fails                                         | Default password is `shipit-dev`. Override via the `NEO4J_PASSWORD` env var if you've changed it.                                                                                                               |
| `pnpm preflight` doesn't pick up a new env var                    | Preflight only checks tool versions and bootstraps `.local.yaml`. Env-var changes are picked up by the next process start.                                                                                      |
| Onboarding wizard keeps reappearing                               | The wizard only re-opens when `devUser` matches the example verbatim and `localStorage` is clean. Set a real name.                                                                                              |
| Webhook deliveries show 200 OK in GitHub but graph doesn't update | 200 from smee only means the relay accepted it. Check the api-server log for the delivery: a `401` is a secret mismatch, a `202` means the refetch was queued — give it a moment, then confirm with "Sync now". |
| Schema editor shows 409 Conflict on save                          | Another writer (or another tab) saved between your read and your write. Reload the page to rebase.                                                                                                              |
| `secretlint` blocks a commit and you're sure it's safe            | It's almost certainly not safe. Read the masked output carefully. Only override with `--no-verify` if you have a documented reason (rare).                                                                      |

---

## Next steps

- [Connectors](./connectors.md) — full connector reference
- [GitHub setup](./connectors/github-setup.md) — App creation runbook
- [Schema Guide](./schema-guide.md) — graph schema reference
- [MCP Tools](./mcp-tools.md) — AI agent integration
- [Architecture](./architecture.md) — system design overview
- [ADR index](./adrs/README.md) — decisions and trade-offs
