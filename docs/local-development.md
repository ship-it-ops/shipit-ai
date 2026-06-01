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
- **`pnpm start:all`** — starts Neo4j + Redis in Docker, seeds demo data
  if the graph is empty, then runs every dev server (`api-server`,
  `core-writer`, `mcp-server`, `web-ui`) in parallel via `turbo dev`.

Then open <http://localhost:3000>.

### The first-run wizard

A dev-mode onboarding modal appears the first time you load the UI. It
collects your name/email/team and writes them to `shipit.config.local.yaml`
under `frontend.devUser`. This is a stand-in until real auth ships
(`backend.mcp.apiKeySecret` is the only real auth surface today). The
wizard is dev-only — production builds skip it entirely. See
[`ADR-015`](./adrs/ADR-015-first-run-dev-onboarding.md) for the design.

---

## 3. Project layout

```
ShipIt-AI/
├── packages/
│   ├── shared/              # Types, Zod schemas, identity utils, canonical model
│   ├── event-bus/           # BullMQ/Redis client (producer + consumer)
│   ├── core-writer/         # Sole Neo4j writer — claim resolution, identity matching
│   ├── connector-sdk/       # ShipItConnector interface, harness, sync state
│   ├── connectors/
│   │   ├── github/          # GitHub App connector
│   │   └── kubernetes/      # Stub (planned)
│   ├── api-server/          # Fastify REST API — /api/*
│   ├── mcp-server/          # MCP server (stdio) — 8 tools for AI agents
│   └── web-ui/              # Next.js 16 dashboard (App Router + React Query)
├── docker/                  # Docker Compose, Dockerfiles, Neo4j init
├── scripts/                 # preflight, infra, seed, dev helpers
├── config/                  # shipit-schema.yaml (graph schema)
├── docs/                    # User docs + ADRs + plans
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
frontend: # Next.js client: api URL, devUser, integration links
connectors: # External integrations (GitHub App identity + connector instances)
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

| Script                | What it starts                                                             |
| --------------------- | -------------------------------------------------------------------------- |
| `pnpm start:infra`    | Docker: Neo4j + Redis only                                                 |
| `pnpm start:backend`  | Infra + `api-server` + `core-writer` (auto-seeds demo data if graph empty) |
| `pnpm start:frontend` | Web UI dev server only                                                     |
| `pnpm start:mcp`      | MCP server only (stdio)                                                    |
| `pnpm start:all`      | Everything in parallel                                                     |
| `pnpm stop`           | Bring all docker-compose services down                                     |
| `pnpm stop:clean`     | Down + delete volumes (wipes Neo4j data)                                   |

### Manual paths

For surgical control:

```bash
# Terminal 1 — infra
docker compose -f docker/docker-compose.yml up -d neo4j redis

# Terminal 2 — api-server (watch mode)
pnpm --filter @shipit-ai/api-server dev

# Terminal 3 — core-writer (watch mode)
pnpm --filter @shipit-ai/core-writer dev

# Terminal 4 — web-ui (Next.js dev server)
pnpm --filter @shipit-ai/web-ui dev
```

### Ports

| Service     | URL                                         | Notes                                     |
| ----------- | ------------------------------------------- | ----------------------------------------- |
| Web UI      | <http://localhost:3000>                     | Next.js                                   |
| API Server  | <http://localhost:3001>                     | Fastify; OpenAPI at `/docs`               |
| Neo4j HTTP  | <http://localhost:7474>                     | Neo4j Browser; login `neo4j`/`shipit-dev` |
| Neo4j Bolt  | `bolt://localhost:7687`                     | driver protocol                           |
| Redis       | `redis://localhost:6379`                    | BullMQ + event bus                        |
| Smee target | `http://localhost:3001/api/webhooks/github` | When you set up webhooks (§10)            |

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
- **Integration tests** that need Neo4j/Redis use docker-compose-managed
  services. Skipped automatically when those aren't reachable.
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
step 1 of the wizard. See [github-setup.md §6b](./connectors/github-setup.md#6b-per-org-github-apps-optional).

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

> **Status:** the webhook receiver lands in P1; until then, deliveries
> arrive at the smee channel and pass through to the API server, which
> currently 404s on `/api/webhooks/github`. You can still set up the
> tunnel now so the wiring is ready when the receiver ships — and so the
> GitHub App's webhook URL doesn't need to change later.

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
- **Webhook secret**: generate one with `openssl rand -hex 32` and paste
  it. Save the same value into your shell as `GITHUB_WEBHOOK_SECRET`
  before restarting the API server (see step 4).
- **SSL verification**: Enabled

Then check the **Subscribe to events** boxes the receiver will care
about in P1: `push`, `pull_request`, `workflow_run`, `deployment`,
`deployment_status`, `member`, `membership`, `team`, `team_add`,
`repository`. (Subscribing now is harmless — deliveries just get
buffered into smee.)

#### Step 4 — Set the webhook secret env var

```bash
export GITHUB_WEBHOOK_SECRET=<the-secret-you-pasted-into-github>
```

Restart `pnpm start:backend` so the API server picks it up.

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

Until the P1 receiver lands you'll see `404` from the API server. That's
fine — it confirms GitHub → smee → your machine works end-to-end. Once
the receiver is in place, the same setup keeps working without any
changes.

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

### Webhook signature verification (P1)

When the receiver lands, it'll verify each delivery's HMAC signature with
`crypto.timingSafeEqual` against the raw request body using the
`GITHUB_WEBHOOK_SECRET` env var. **Both smee and ngrok preserve the
`X-Hub-Signature-256` header verbatim**, so signature verification works
identically over either tunnel. If you see signature failures, the most
common cause is the secret in GitHub not matching the env var (e.g. you
regenerated it on one side without updating the other).

### Common webhook gotchas

| Symptom                                        | Cause / fix                                                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| GitHub shows red ✗ on deliveries               | Smee or ngrok URL doesn't match the App's webhook URL — re-paste.                                           |
| smee-client says "ECONNREFUSED localhost:3001" | `api-server` isn't running. Start it with `pnpm start:backend`.                                             |
| 401 on `/api/webhooks/github` after P1 ships   | `GITHUB_WEBHOOK_SECRET` env var differs from the App's webhook secret.                                      |
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

The MCP server exposes 8 tools to AI agents. To connect Claude Desktop /
Claude Code to your local graph, add to your MCP config (e.g.
`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "shipit-ai": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js"],
      "cwd": "/absolute/path/to/ShipIt-AI",
      "env": {
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USER": "neo4j",
        "NEO4J_PASSWORD": "shipit-dev"
      }
    }
  }
}
```

Restart Claude after editing. See [mcp-tools.md](./mcp-tools.md) for the
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

CI runs `pnpm turbo build`, `pnpm turbo typecheck`, `pnpm turbo test`,
and `pnpm exec secretlint --secretlintrc .secretlintrc.json "**/*"`. If
those four pass locally, the PR should be green.

---

## 14. Troubleshooting

| Symptom                                                           | Likely cause / fix                                                                                                                         |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `Config validation failed` on `pnpm start:*`                      | A required env var isn't set, or `.local.yaml` has a shape mismatch. Error message points at the failing path.                             |
| `Cannot find module '@shipit-ai/...'`                             | Build cache mismatch. Run `pnpm install && pnpm turbo build`.                                                                              |
| Connector card stuck on `not_connected`                           | Initial sync hasn't finished — check the Runs tab in the connector drawer for the latest run's error.                                      |
| `SyncScheduler init failed: ...` at API server boot               | Either Redis isn't reachable, or the GitHub App private key file at `$GITHUB_APP_PRIVATE_KEY_PATH` is missing.                             |
| Neo4j browser login fails                                         | Default password is `shipit-dev`. Override via the `NEO4J_PASSWORD` env var if you've changed it.                                          |
| `pnpm preflight` doesn't pick up a new env var                    | Preflight only checks tool versions and bootstraps `.local.yaml`. Env-var changes are picked up by the next process start.                 |
| Onboarding wizard keeps reappearing                               | The wizard only re-opens when `devUser` matches the example verbatim and `localStorage` is clean. Set a real name.                         |
| Webhook deliveries show 200 OK in GitHub but graph doesn't update | The P1 receiver isn't in main yet — polling is what fills the graph today. Confirm by running "Sync now".                                  |
| Schema editor shows 409 Conflict on save                          | Another writer (or another tab) saved between your read and your write. Reload the page to rebase.                                         |
| `secretlint` blocks a commit and you're sure it's safe            | It's almost certainly not safe. Read the masked output carefully. Only override with `--no-verify` if you have a documented reason (rare). |

---

## Next steps

- [Connectors](./connectors.md) — full connector reference
- [GitHub setup](./connectors/github-setup.md) — App creation runbook
- [Schema Guide](./schema-guide.md) — graph schema reference
- [MCP Tools](./mcp-tools.md) — AI agent integration
- [Architecture](./architecture.md) — system design overview
- [ADR index](./adrs/README.md) — decisions and trade-offs
