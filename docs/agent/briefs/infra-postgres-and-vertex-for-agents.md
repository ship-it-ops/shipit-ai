# Infra brief — Postgres (instance + schema apply) and Vertex AI access for the agent platform

**For:** `Ship-It-Ops/shipit-ai-infra` (Terraform + the `charts/shipit-ai` umbrella chart + `deploy.yml`).
**From:** app repo, 2026-10-01. **Enables:** user-defined AI agents and workflows
(`docs/agent/plans/ai-agents-and-workflows.md`, `docs/agent/decisions/agent-platform-v1-foundations.md`).
**Fires your revisit trigger:** `docs/agent/decisions/future-postgres-config-store.md` (D15) —
the app is now building on Postgres.

You are working in the infra repo. Read its `docs/agent/MANIFEST.md`, `status/` and
`instructions/` first; its standing instructions (never commit without asking, no commit
signature) apply. This brief says what the app needs and why. Where it says "infra decides",
pick what fits the repo's conventions and record the choice as a decision note.

## What the app is building

Users will define AI agents in the web UI (instructions, model, tool grants, triggers) and
compose them into workflows. That adds three things the cluster does not have today:

1. A **relational store** for agent definitions, versions, tool grants, triggers, runs, run
   steps and approvals. Run transcripts are too large for Redis (see the 2026-06-17 Redis OOM)
   and a poor fit for Neo4j.
2. **Model inference through Vertex AI**, authenticated by Workload Identity. No API keys.
3. A new long-running worker, **`agent-runner`**, that executes agent runs. It does not exist
   yet; its Deployment is a follow-up brief (see "Not in this brief").

The owner decided on 2026-10-01 that **the infra repo creates the database and applies schema
changes for now**. The app does not run migrations at boot.

## Required changes

### 1. Postgres instance (demo tier)

Follow the shape D15 already records: **in-cluster StatefulSet, single replica, small PVC,
headless Service**, inside the umbrella chart, mirroring the Redis templates.

- A currently supported Postgres major (16 or newer). Pin the major version in the image tag.
- One database, `shipit`, UTF-8. No extensions are required (`gen_random_uuid()` is built in).
- **Two roles:**
  - `shipit_migrator` — owns the schema and runs DDL. Used only by the migration step below.
  - `shipit_app` — DML only (`SELECT, INSERT, UPDATE, DELETE` on tables, `USAGE` on sequences),
    granted through default privileges so new tables are covered automatically. Used by
    `api-server` now and `agent-runner` later.
- Resources: infra decides, but the app's needs are small (tens of connections, low write
  rate). Something like requests `100m / 256Mi` is enough to start. The node pool must still
  fit it; D15 flagged the cost ceiling for a revisit when this landed.
- **Zonal PV:** the PVC will be zonal, the same as Redis. Apply the lesson from your
  2026-07-02 Redis zonal-PV strand scar and runbook so a Spot reclaim into another zone
  cannot strand the Postgres pod.
- **Backups:** agent definitions and run history are user-authored data, unlike Redis. At
  minimum, document that losing the PVC loses them. Preferred: a nightly `pg_dump` CronJob to
  a GCS bucket with roughly 14 days of retention. Infra decides the mechanism.
- Company prod is still expected to move to Cloud SQL via a `DATABASE_URL` swap (D15). Nothing
  here should assume the in-cluster instance is permanent.

### 2. Connection secrets

- GSM containers (via `terraform/modules/secret-manager`) for the two connection strings, for
  example `shipit-database-url` (the `shipit_app` role) and `shipit-database-migrator-url`.
- Deliver the app one through **ESO as the env var `DATABASE_URL`** on `api-server` (and later
  `agent-runner`). The migrator URL goes only to the migration step.
- The app will **not** read this secret from GSM directly; it consumes the pre-set env var.
  This avoids a repeat of the 2026-09-16 boot crash (app reading an ESO-delivered secret it
  had no grant on).
- **Ship order is flexible.** When `DATABASE_URL` is unset the app disables agent features and
  everything else runs as it does today, so this can land before or after the app change.

### 3. Schema apply at deploy time

Schema files live in the **app repo** so that local development, CI integration tests and
self-hosters get the same schema. The infra repo **applies** them. Contract:

- Path in the app repo: `db/migrations/`. Files are plain SQL named `NNNN_description.sql`
  (four digits, zero-padded, strictly increasing), forward-only. An applied file is never
  edited; changes arrive as new files.
- At deploy, fetch that directory **at the same SHA as the image**, the same binding
  `deploy.yml` already does for `shipit.config.yaml` (D17a). It is a directory, so the fetch
  needs a listing rather than a single `contents` call.
- Apply pending files in order, each in its own transaction, as `shipit_migrator`, recording
  each in a tracking table `schema_migrations(version text primary key, applied_at
timestamptz not null default now())`. `version` is the four-digit prefix.
- Run this **before app pods roll** (a Helm pre-upgrade hook Job is the obvious fit) and
  **fail the deploy** if a file fails.
- **Tolerate an absent or empty `db/migrations/`** as a no-op. The first migration files land
  with the app change, after this brief.
- Tool choice is yours (plain `psql` in a Job, dbmate, or similar), as long as the contract
  above holds. The app checks `schema_migrations` at boot and disables agent features, without
  crashing, if the schema is older than it expects.

### 4. Vertex AI access

- Enable `aiplatform.googleapis.com` on project `ship-it-ai-portal` (Terraform).
- New GCP service account for the worker, for example `shipit-agent-runner`, with
  `roles/aiplatform.user` on the project. Bind it by Workload Identity to a new KSA
  `shipit/agent-runner`, following D7 (a new GSA per workload; do not widen an existing one).
  `api-server` does not call models and needs no Vertex role.
- Non-secret env for the worker (ConfigMap): `GOOGLE_CLOUD_PROJECT` and
  `GOOGLE_CLOUD_LOCATION=global`. The app authenticates with Application Default Credentials.
- **Operator step, cannot be Terraformed as far as we know:** partner and open models must be
  enabled per project in Model Garden. Someone with
  `roles/consumerprocurement.entitlementManager` enables each model card, and Anthropic's
  Claude models require accepting terms of service. Org policy must allow
  `cloudcommerceconsumerprocurement.googleapis.com`. Please add this to the runbook and tell
  the owner which models are enabled. Start with the current Claude Opus, Sonnet and Haiku
  models and Gemini.
- Check the project's default Claude quota on the `global` endpoint and note it; newer Claude
  models share per-family quota buckets.
- **Spend guard:** agents can run on schedules with nobody watching. Add a budget alert for
  Vertex AI spend on the project (the `monitoring` module is the likely home). The app
  enforces per-run and per-agent caps as well; this is the backstop.

### 5. Agent platform key

- One more GSM container, for example `shipit-agent-platform-key`: 32 random bytes,
  base64-encoded, generated once (Terraform `random_bytes` or an operator command) and never
  rotated automatically.
- Deliver it through **ESO as the env var `SHIPIT_AGENT_PLATFORM_KEY`** on `api-server` now and
  on `agent-runner` later. Same tier as the session secret: the app only reads the env var.
- What it protects: the app derives two subkeys from it. One encrypts the credentials users
  enter for agent tool connections (external MCP tokens, the GitHub actions App private key),
  which are stored in Postgres. The other signs the short-lived tokens the worker uses to call
  `api-server` on an agent's behalf.
- **Losing or replacing this key makes every stored tool-connection credential unreadable.**
  Treat it like the Postgres data: it must survive teardown and rebuild, and it must not be in
  the demo-reset drain list.

## Not in this brief

- **The `agent-runner` Deployment and image.** The package and Dockerfile do not exist yet. A
  follow-up brief will ask for: a `Deployment` with no Service (same shape as `core-writer`),
  `replicas: 1`, KSA `agent-runner`, env from the app ConfigMap plus `DATABASE_URL`, Redis and
  Neo4j settings, and an `agent-runner` entry in `build-images.yml`. Creating the KSA and GSA
  now is welcome.
- **Cloud SQL.** Stays the company-prod path per D15.
- **Kubernetes write RBAC for agent actions.** Decided against for this release. Agents stay
  read-only toward the cluster; no RBAC change is needed.

## Done when

1. `kubectl -n shipit exec` into the Postgres pod: `psql` as `shipit_app` can `SELECT 1` on
   database `shipit`, and cannot `CREATE TABLE`.
2. `api-server` has `DATABASE_URL` in its environment after a deploy.
3. A deploy with no `db/migrations/` directory at the image SHA succeeds, and the migration
   step logs that there was nothing to apply.
4. A deploy with one test migration applies it once, records it in `schema_migrations`, and a
   second deploy at the same SHA applies nothing.
5. A pod running as KSA `shipit/agent-runner` can obtain a token for `shipit-agent-runner` and
   call a Vertex model (a one-off `curl` to a Gemini `generateContent` endpoint is enough).
6. `api-server` has `SHIPIT_AGENT_PLATFORM_KEY` in its environment, and the container is
   excluded from the demo-reset drain.
7. The runbook covers: Model Garden enablement, restoring Postgres from backup, and the
   zonal-PV recovery path.

## Notes / safety

- Project `ship-it-ai-portal`, cluster `shipit-demo`, namespace `shipit`.
- Nothing here changes existing workloads' behaviour. `api-server` gains one env var it
  ignores until the app change ships.
- Please report back: the Postgres major chosen, the service DNS name and port, the exact GSM
  container names, the GSA email, and which Model Garden models were enabled. The app's secret
  registry and config will use those names.
