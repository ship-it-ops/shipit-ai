# Deployment

Two ways to run ShipIt-AI:

- **Docker Compose** (`docker/docker-compose.yml`) — the whole stack on one machine, for evaluation and for local development's infrastructure.
- **Kubernetes (GKE)** — how the hosted instance runs. The application repository holds the Dockerfiles and the configuration contract; the private infrastructure repository (`shipit-ai-infra`) holds the Helm chart, builds and publishes the images, and runs the deploys ([ADR-023](adrs/ADR-023-hosting-on-gke-images-built-by-infra.md)).

Whichever way, every backend process reads the same `shipit.config.yaml`; a deployment is the set of environment variables and secrets that fill its placeholders. Start with [Configuration contract](#configuration-contract).

## Docker Compose

| Service            | Image / build                                             | Ports      | Role                                                                    |
| ------------------ | --------------------------------------------------------- | ---------- | ----------------------------------------------------------------------- |
| `neo4j`            | `neo4j:5-community` (APOC, 512m–1G heap)                  | 7474, 7687 | Knowledge graph                                                         |
| `redis`            | `redis:7-alpine`                                          | 6379       | Queues, sessions, run history, heartbeats                               |
| `postgres`         | `pgvector/pgvector:0.8.7-pg17`                            | 5432       | Agents, runs, knowledge documents and embeddings                        |
| `migrate`          | api-server image, one-shot                                | —          | Creates the pgvector extension and applies `db/migrations/`, then exits |
| `api-server`       | `packages/api-server/Dockerfile`                          | 3001       | REST API, sync schedulers, webhook receiver                             |
| `core-writer`      | `packages/core-writer/Dockerfile`                         | —          | Graph writer                                                            |
| `mcp-server`       | `packages/mcp-server/Dockerfile`                          | 3002       | MCP tools over Streamable HTTP (`MCP_TRANSPORT=http`)                   |
| `web-ui`           | `packages/web-ui/Dockerfile` (`SHIPIT_API_URL` build arg) | 3000       | Dashboard                                                               |
| `agent-runner`     | `packages/agent-runner/Dockerfile`                        | —          | Works agent runs on Vertex AI — **profile `agents`**                    |
| `knowledge-worker` | `packages/knowledge-worker/Dockerfile`                    | —          | Chunks and embeds documents on Vertex AI — **profile `knowledge`**      |

```bash
# Full stack (without the two Vertex-backed workers)
docker compose -f docker/docker-compose.yml up -d

# Add a worker: both mount ~/.config/gcloud for application-default credentials
docker compose -f docker/docker-compose.yml --profile agents --profile knowledge up -d

# Infrastructure only, for local development (also bootstraps pgvector and migrates)
pnpm start:infra

# Rebuild after code changes
docker compose -f docker/docker-compose.yml up -d --build
```

Start order: `neo4j` and `redis` must be healthy before `core-writer` and `mcp-server`; `postgres` must be healthy before `migrate`, and `migrate` must have completed before `api-server` and the two workers; `web-ui` waits for `api-server`.

Each backend container mounts the committed `shipit.config.yaml` (and the api-server also `config/shipit-schema.yaml`) read-only and receives only the environment variables the YAML's placeholders need: `NEO4J_URI` and `REDIS_URL` pointing at the compose network, `NEO4J_USER` and `NEO4J_PASSWORD` (host values, defaulting to `neo4j` / `shipit-dev`), `SHIPIT_API_URL` and `SHIPIT_WEB_ORIGIN` (the host-facing `http://localhost:3001` and `:3000`), `DATABASE_URL`, and for the workers `GOOGLE_CLOUD_PROJECT`. Sign-in is **on** in the committed config, so a compose stack boots into [setup mode](#first-boot-setup-mode) until it is configured.

Volumes: `neo4j_data`, `neo4j_logs`, `redis_data`, `postgres_data`. `docker/neo4j/init.cypher` is mounted into Neo4j's import directory for manual use; nothing runs it automatically. `docker/postgres-init/01-vector.sql` creates the pgvector extension on a fresh volume.

Neo4j Browser is at <http://localhost:7474> (`neo4j` / the password above).

## Configuration contract

`shipit.config.yaml` is the single configuration file; `${VAR}` placeholders in it are the deployment's inputs ([ADR-014](adrs/ADR-014-layered-local-configuration.md)). A placeholder with no fallback and no value stops the process at boot with the offending path. These are required by **every backend process**, including the workers that open no HTTP port:

| Variable            | Fills                                 | Notes                                                               |
| ------------------- | ------------------------------------- | ------------------------------------------------------------------- |
| `NEO4J_URI`         | `backend.neo4j.uri`                   | `bolt://` locally; `neo4j+s://` for Aura                            |
| `NEO4J_USER`        | `backend.neo4j.user`                  | `neo4j` on a self-hosted instance                                   |
| `NEO4J_PASSWORD`    | `backend.neo4j.password`              | A secret (`neo4j-aura-password` in the registry)                    |
| `REDIS_URL`         | `backend.redis.url`                   | Sessions and run history live here when auth is on                  |
| `SHIPIT_API_URL`    | `frontend.api.url`                    | Public URL of the API as the browser sees it (`/api` on one origin) |
| `SHIPIT_WEB_ORIGIN` | `accessControl.web.allowedOrigins[0]` | The web UI's origin, for credentialed CORS                          |

Optional placeholders, each with a fallback: `DATABASE_URL` (Postgres for agents and knowledge; without it the AI routes answer `503 AI_UNAVAILABLE`), `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` (Vertex AI, default location `global`), `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_PATH`, `GITHUB_WEBHOOK_PUBLIC_URL` (the shared GitHub App), `OIDC_ISSUER_URL`, `OIDC_CLIENT_ID`, `OIDC_DISPLAY_NAME`, `GITHUB_OAUTH_CLIENT_ID` (sign-in providers), `SHIPIT_FEEDBACK_REPO_OWNER` / `_NAME` (feedback widget).

Secrets never appear in the YAML. The `secrets:` registry declares each logical secret, the environment variable that carries it and the Secret Manager container it lives in ([ADR-025](adrs/ADR-025-secrets-in-google-secret-manager.md)): `SHIPIT_SESSION_SECRET` (32+ characters; `openssl rand -base64 48`), `OIDC_CLIENT_SECRET`, `GITHUB_OAUTH_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`, `SHIPIT_AUTH_ADMINS` and `SHIPIT_AUTH_ALLOWLIST` (comma-separated emails), `FEEDBACK_GITHUB_TOKEN`, plus the GitHub App key as a file and two store-only blobs (`setup-completed`, `connector-apps`). `SHIPIT_GSM_SECRET_<NAME>` overrides a container name per environment.

Process-level variables, read outside the YAML:

| Variable                                                            | Process        | Purpose                                                                                                   |
| ------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------- |
| `SHIPIT_CONFIG`                                                     | all            | Explicit path to `shipit.config.yaml` (default: walk up from the working directory)                       |
| `SHIPIT_SECRET_STORE`                                               | api-server     | `file` (default) or `gsm`; `gsm` needs `GOOGLE_CLOUD_PROJECT`                                             |
| `SHIPIT_GITHUB_APP_KEY_DIR`                                         | api-server     | Where App private keys, webhook secrets and Kubernetes credentials are written (default `~/.shipit/keys`) |
| `SHIPIT_FORCE_SETUP_MODE=1`                                         | api-server     | Development hatch into setup mode                                                                         |
| `MCP_TRANSPORT`, `MCP_HTTP_PORT`                                    | mcp-server     | `http` (default) or `stdio`; port 3002                                                                    |
| `NEO4J_USERNAME`, `NEO4J_DATABASE`                                  | core-writer    | Its own driver settings; `NEO4J_DATABASE` matters on Aura                                                 |
| `DATABASE_MIGRATOR_URL`, `DATABASE_SUPERUSER_URL`, `MIGRATIONS_DIR` | migrations CLI | Role-specific connection strings for `pnpm db:migrate` / `pnpm db:bootstrap`                              |

The web UI is different: it consumes only `frontend.*`, flattened into `NEXT_PUBLIC_SHIPIT_*` variables **at build time**, so the image is built with `SHIPIT_API_URL` as a build argument (`/api` on a single-origin deployment) and needs `shipit.config.yaml` present during the build.

## Production on GKE

### Topology

- A single-origin **Ingress** with a managed certificate and HTTPS redirect routes `/api` to `api-server:3001`, `/mcp` to `mcp-server:3002` and `/` to `web-ui:3000`. One origin keeps the session cookie first-party; `backend.api.trustProxy: true` lets the api-server see the TLS termination and set the `Secure` cookie.
- **Neo4j** is managed (Aura, `neo4j+s://`), outside the cluster.
- **Redis** is a StatefulSet with a persistent volume, append-only persistence and `noeviction`, with `--maxmemory` kept below the container's memory limit.
- **Postgres** runs from its own chart (`shipit-postgres`): a StatefulSet on a regional persistent disk with a nightly dump to object storage; roles `shipit_migrator` (schema) and `shipit_app` (runtime).
- **Secrets** reach the pods through External Secrets Operator from Google Secret Manager, with Workload Identity; the api-server additionally reads and writes its feature secrets through the `gsm` store.
- `api-server` and `core-writer` run one replica each on a Spot node pool; the demo tier is not highly available.

### Images and deploys

The infrastructure repository's `build-images` workflow clones this repository at a chosen ref, builds `api-server`, `core-writer`, `mcp-server` and `web-ui` (the web UI with `SHIPIT_API_URL=/api`), scans them with Trivy (fixable HIGH/CRITICAL findings block), and pushes immutable `sha-<short sha>` tags. `agent-runner` and `knowledge-worker` have Dockerfiles and compose entries here but are not yet in that build matrix. This repository's own CI `docker` job builds the backend images with `push: false`, for validation only, and holds no cloud credentials.

Deploys are two operator-triggered steps — build, then `deploy` with the resulting tag. There is no deploy on merge. The deploy fetches `shipit.config.yaml` and `config/shipit-schema.yaml` **at the same SHA as the image** into a ConfigMap; an init container copies them to a writable `emptyDir` and the process runs with `SHIPIT_CONFIG=/data/shipit.config.yaml` ([ADR-024](adrs/ADR-024-runtime-config-persistence.md)). Consequences:

- A configuration-only change still needs a build and a deploy at the new SHA.
- Edits the UI writes to the config file (schema, connector instances) **revert on any pod restart**. Credentials and per-org connectors survive because they live in Secret Manager (the `connector-apps` blob); `GET /api/config/export` returns the merged, secret-scrubbed configuration to commit as the next seed.

Before dispatching a build, run `pnpm audit` on the exact SHA: the Trivy gate uses a fresher advisory database than a pull request's checks did, and a `main` that was clean at merge time can fail to build days later ([ADR-032](adrs/ADR-032-dependency-and-image-hygiene.md)).

### Database migrations

`db/migrations/` is forward-only SQL (`NNNN_description.sql`); the application never migrates at boot. Locally `pnpm start:infra` applies pending files; on GKE a pre-upgrade hook Job runs the same CLI from the image being deployed, and a failed migration fails the atomic Helm upgrade. A file runs under a 5-second lock timeout so it cannot stall a database in use; a file whose first line is `-- migrate: no-transaction` runs outside a transaction (for `CREATE INDEX CONCURRENTLY`). When you add a migration, bump the expected schema version in `packages/agents/src/schema-version.ts` (and `KNOWLEDGE_MIGRATIONS` in `packages/knowledge/src/schema-version.ts` for a knowledge table) in the same change.

### Secrets

With `SHIPIT_SECRET_STORE=gsm`, boot **hydration** runs before the configuration loads: for each secret in the registry whose environment variable is empty, the api-server reads the latest version from Secret Manager into `process.env` (and materialises the GitHub App key as a file). Rules that have each caused an outage:

- A value already present in the environment wins and is not read — the bootstrap secrets (`NEO4J_PASSWORD`, `SHIPIT_SESSION_SECRET`, `DATABASE_URL`) arrive through ESO and the app has no grant on their containers.
- A registry secret whose **container does not exist** crashes the boot; an **empty** container means "first run". Every new logical secret needs its container and IAM grant on the infrastructure side before the image that uses it deploys.
- Only the wizards write (the GitHub App manifest exchange, setup, the OIDC and webhook settings); the store refuses to write bootstrap secrets.
- The admin list and the sign-in allow-list are read at boot: after `gcloud secrets versions add`, a rollout restart of `api-server` applies them.

### First-boot setup mode

The committed configuration is safe by default — sign-in on, no provider, no admins — so a fresh deployment cannot pass the bootability check. Instead of crashing, the api-server boots into **setup mode** when the only failing gates are ones a wizard can fix ([ADR-026](adrs/ADR-026-first-boot-setup-mode.md)): `GET /api/health` reports `mode: "setup"`, the web UI shows a public `/setup` page, only `/api/setup/*`, the GitHub App manifest flow and the webhook receiver answer, and everything else is `401 SETUP_MODE`. The first administrator signs in with a GitHub OAuth App the wizard creates, their email is written to the `auth-admin-emails` secret, and `POST /api/setup/complete` writes the one-way `setup-completed` latch and exits the process; Kubernetes restarts it with authentication enforced. Operator-only gates — the session secret, the allowed origins — always fail loud. To re-run setup on purpose, delete the latch's secret versions.

### Vertex AI

The agent runner and the knowledge worker call Vertex AI with Workload Identity (no API keys): their service accounts need `roles/aiplatform.user` in the project named by `GOOGLE_CLOUD_PROJECT`, and the models listed under `ai.models` must be enabled in that project's Model Garden by hand (the committed default model is Gemini). Both workers heartbeat to Redis; `GET /api/ai/status` and `GET /api/knowledge/status` show whether one is alive. The agent runner needs a 60-second termination grace period to finish a step, and `GET /api/runs/:id/stream` is server-sent events, so the load balancer's backend timeout must exceed its 30-second keepalive.

### Resources

What the hosted demo tier runs with (requests → limits):

| Service     | CPU         | Memory        | Notes                                                                              |
| ----------- | ----------- | ------------- | ---------------------------------------------------------------------------------- |
| api-server  | 100m → 500m | 256Mi → 512Mi | Startup probe allows 150 s: Secret Manager hydration is slow                       |
| core-writer | 50m → 300m  | 192Mi → 384Mi |                                                                                    |
| mcp-server  | 50m → 300m  | 128Mi → 256Mi | Load-balancer health check on `GET /health`                                        |
| web-ui      | 50m → 300m  | 128Mi → 256Mi | Load-balancer health check on `/login` (a literal 200)                             |
| Redis       | 50m         | 512Mi → 1Gi   | `--maxmemory 768mb`; the dataset reached ~246 MB once and OOM-killed a 256Mi limit |
| Postgres    | 100m → 1    | 1Gi → 2Gi     | Separate chart                                                                     |
| Neo4j       | —           | —             | Managed (Aura)                                                                     |

### What the incidents taught

- **502 on every path, including `/api/health`** — the load balancer's network endpoint group has no backends (node recreation drained it); it self-heals when the pods reschedule. Check the NEG before the application.
- **Atomic Helm upgrade times out with only `api-server` in `BackOff`** — a boot crash, not capacity. Read the crashed pod's logs first; the two cases so far were a missing Secret Manager container and a read of a secret the app had no grant on.
- **"All data is gone"** — Redis was unreachable or OOM-killed; the graph in Aura was intact. Keep `--maxmemory` below the container limit; the api-server now degrades instead of crashing when Redis is full.
- **Login loop** — the `Secure` session cookie was dropped because the api-server did not trust the proxy; `backend.api.trustProxy: true` is required behind TLS termination.

## Docker images

All six images are multi-stage `node:22-alpine` builds. The runtime stages run `apk upgrade` and remove the base image's bundled npm CLI, which is what keeps them through the Trivy gate ([ADR-032](adrs/ADR-032-dependency-and-image-hygiene.md)); the backend images are assembled with `pnpm deploy --legacy --prod` from a build stage that compiles every workspace package the service depends on (a new workspace dependency has to be added to that stage's `COPY` list, or the image build is the first thing to fail). The web UI image is a standalone Next.js build that runs as a non-root user.

## Security notes

- Sign-in is on by default; a deployment that forgets to configure a provider, admins, the session secret or the allowed origins fails at boot rather than opening up.
- The MCP endpoint requires a personal access token on every request ([ADR-028](adrs/ADR-028-mcp-token-auth.md)); raw Cypher, in the UI and over MCP, is reserved to administrators ([ADR-036](adrs/ADR-036-raw-cypher-read-only-check-and-executor.md)).
- CORS is the allow-list in `accessControl.web.allowedOrigins`; the global rate limit is 200 requests per minute per IP, with stricter limits on the expensive routes.
- Secrets live in Secret Manager; the public repository's CI never holds registry or cloud credentials.
- Vulnerability reports: see [SECURITY.md](../SECURITY.md).
