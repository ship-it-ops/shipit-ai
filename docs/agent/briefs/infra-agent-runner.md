# Infra brief 2 — the `agent-runner` Deployment

**For:** `Ship-It-Ops/shipit-ai-infra` (the `charts/shipit-ai` umbrella chart, `build-images.yml`, `deploy.yml`).
**From:** app repo, 2026-10-03. **Follows:** [infra-postgres-and-vertex-for-agents](infra-postgres-and-vertex-for-agents.md)
(brief 1, worked in your PR #91: Postgres 17, the migration hook, the Vertex GSAs).
**Plan:** `docs/superpowers/plans/2026-10-03-agent-runner.md` in the app repo.

You are working in the infra repo. Read its `docs/agent/MANIFEST.md`, `status/` and
`instructions/` first; its standing instructions apply. Where this says "infra decides",
pick what fits the chart's conventions and record it.

## What the app now has

A new long-running worker, **`agent-runner`** (`packages/agent-runner`). It takes run ids
from the BullMQ queue `shipit-agent-runs` on the existing Redis, calls models on Vertex AI,
runs the graph read tools against Neo4j, and records every step in Postgres. It serves no
HTTP and has no Service. It writes a heartbeat (`shipit-agent-runner-heartbeat`, 60 s
expiry) that `GET /api/ai/status` reads; with no runner, agent runs answer 503 and the rest
of the product is unaffected.

## Required changes

### 1. Image

Build and publish `packages/agent-runner/Dockerfile` (repo root as context) in
`build-images.yml`, alongside api-server, core-writer and mcp-server, with the same
tagging, scanning and pinning. The app repo's CI builds it in its docker matrix too.

### 2. Deployment

- `replicas: 1`. More would work (runs are leased in Postgres), but v1 does not exercise it.
- **KSA `shipit/agent-runner`**, which PR #91 already bound to the GSA
  `shipit-agent-runner` with `roles/aiplatform.user`. No other Google role.
- Config: mount `shipit.config.yaml` at `/app/shipit.config.yaml` like the other workers.
- Environment, the same names the other services use where they overlap:

  | Variable                                    | Value                                                     |
  | ------------------------------------------- | --------------------------------------------------------- |
  | `DATABASE_URL`                              | from the ExternalSecret `shipit-agent-secrets` (app role) |
  | `REDIS_URL`                                 | the in-cluster Redis                                      |
  | `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD` | the graph, as `core-writer` gets them                     |
  | `SHIPIT_API_URL`, `SHIPIT_WEB_ORIGIN`       | as `core-writer` gets them (see below)                    |
  | `GOOGLE_CLOUD_PROJECT`                      | `ship-it-ai-portal`                                       |
  | `GOOGLE_CLOUD_LOCATION`                     | `global`                                                  |

  The runner serves no HTTP, but it reads the same mounted `shipit.config.yaml` as every
  other backend service, and the loader refuses to start while any placeholder without a
  fallback is unset: `NEO4J_USER`, `SHIPIT_API_URL` and `SHIPIT_WEB_ORIGIN` among them. A
  pod without them exits at boot with `Config error at …: references env var … which is not
set`.

  It does **not** need `SHIPIT_AGENT_PLATFORM_KEY` yet (graph-write tools and connection
  secrets arrive with Milestone 3; a later brief will say so). Do not route `envFrom` the
  whole `shipit-agent-secrets` Secret into it for that reason.

- Resources: infra decides. It is I/O-bound (waiting on Vertex and Postgres); requests
  around `100m / 256Mi` and a `512Mi` limit should be ample at `ai.runner.concurrency: 4`.
- Probes: no readiness probe. A crash restarts the pod. A hung process is **not** recovered
  by the app: the sweeper that fails runs without progress and re-queues expired leases
  lives inside the runner, so with one replica a wedged runner leaves its runs `running`
  and nothing restarts it. `/ai/status` does show the runner as down (its Redis heartbeat,
  `shipit-agent-runner-heartbeat`, expires), so either alert on that check or give the pod
  an exec liveness probe; the app does not ship one yet.
- `terminationGracePeriodSeconds: 60`. On SIGTERM the runner stops taking jobs and waits
  for runs in progress; a run cut off by the kill resumes on the next pod within about a
  minute (its lease expires and the sweeper re-queues it). A write that was in flight is
  reported to the model as "outcome unknown" and never repeated.
- Rollout: `deploy.yml` / `helm-spin-up.yml` after `shipit-postgres` (the runner waits for
  the schema itself, so ordering against the migration hook is not critical).

### 3. Egress

To `aiplatform.googleapis.com` (Vertex) only, for now. GitHub and external MCP hosts come
with Milestone 3.

### 4. Streaming through the load balancer (api-server, not the runner)

`GET /api/runs/:id/stream` is a long-lived Server-Sent Events response. The app sends a
keep-alive comment every 15 s and the browser resumes with `Last-Event-ID` after any cut,
so nothing is lost, but GCLB's backend service timeout (30 s by default) would cut every
stream at 30 s. If the api-server sits behind GCE Ingress, give it a `BackendConfig` with a
longer `timeoutSec` (an hour is common for SSE). Infra decides the value.

## Not in this brief

- `SHIPIT_AGENT_PLATFORM_KEY` for the runner, GitHub and MCP egress (Milestone 3).
- Any change to Postgres sizing: the runner adds about six connections.

## How the app checks it

`GET /api/ai/status` on portal-demo answers `"available": true` with every check green, and
asking the built-in Graph assistant a question from AI → Ask (or `POST
/api/agents/:id/runs`) returns an answer with its tool calls recorded.
