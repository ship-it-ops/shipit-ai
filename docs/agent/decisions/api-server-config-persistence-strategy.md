---
type: decision
status: active
created: 2026-06-07
updated: 2026-06-07
author: claude-session-2026-06-07
tags: [deployment, kubernetes, gke, persistence, config, postgres, state, cross-repo]
importance: core
---

# api-server runtime config persistence: ephemeral emptyDir for v1, Postgres store next

## Context

The infra repo (`Ship-It-Ops/shipit-ai-infra`) paused the GKE Helm chart (their
D13) on a cross-repo question: three api-server write paths don't survive the
docker-compose → Kubernetes translation, because a pod's filesystem is
disposable and a ConfigMap mount is read-only. The three paths:

1. **`schema-history/` + the live schema file** — `SchemaService.updateSchema`
   rewrites the schema file in place via `rename(tmp, schemaPath)` and snapshots
   the prior version under `schema-history/`
   (`packages/api-server/src/services/schema-service.ts`).
2. **`~/.shipit/keys/`** — the in-product GitHub App _manifest_ flow writes a PEM
   - webhook-secret (`github-app-manifest-service.ts`). Already env-overridable
     via `SHIPIT_GITHUB_APP_KEY_DIR` (wired at `index.ts:106`).
3. **`shipit.config.local.yaml`** — connector instances written via atomic
   `renameSync` (`connector-registry.ts`), deep-merged over the committed base at
   boot (`packages/shared/src/config/loader.ts`).

Two facts reframed the original A/B/C brief:

- The **live schema file write is a `rename` onto the would-be-ConfigMap file**,
  so a read-only `subPath` mount makes UI schema edits _fail with `EROFS`_, not
  merely fail to persist. Making writes even _succeed_ requires a writable parent
  dir regardless.
- **Run history already left YAML for Redis** (see
  `connector-run-storage-redis-not-yaml`), so `*.local.yaml` is now purely
  low-frequency user-authored config — and the app **already supports
  `SHIPIT_CONFIG`** to relocate the whole config dir (`find-root.ts:13`).

The codebase has **no SQL/Postgres/ORM today** — it is Neo4j + Redis only.

## Decision

A **two-phase** strategy, with a **store-interface backbone** so the demo and the
production-grade build share one code path:

**Phase 1 — GKE v1 (ships now, ≈zero app code change).** Editable-but-ephemeral
config via writable `emptyDir`:

- ConfigMap (the committed `shipit.config.yaml` + schema file) is mounted
  **read-only** as the immutable seed.
- An **init container copies the seed into a writable `emptyDir`** (`/data`) at
  pod start.
- The main container sets **`SHIPIT_CONFIG=/data/shipit.config.yaml`** — already
  supported, so all writes (live schema, `schema-history/`, `*.local.yaml`) land
  in `/data` and **succeed**.
- On any pod restart/redeploy the `emptyDir` is wiped and re-seeded → **schema
  AND connector edits revert to the committed baseline.** "Lost on redeploy"
  really means "lost on any pod restart" (crash/OOM/eviction/maintenance too).
- api-server stays a **`Deployment` at `replicas: 1`** — **no PVC, no
  StatefulSet.**
- GitHub App private key delivered via **Secret** (already in the GKE plan);
  manifest wizard works but is ephemeral and discouraged in prod.

**Phase 2 — Postgres config store (next).** Postgres is the source of truth for
mutable runtime state:

- Extract **`ConnectorConfigStore`** out of `ConnectorRegistry` and
  **`SchemaStore`** out of `SchemaService` — same "interface + default impl +
  production swap" pattern already used for `ConnectorRunStore`
  (Redis/in-memory) and `ConnectorRunner` (Noop/BullMQ). API routes don't change.
- Ship `Postgres*` implementations alongside the existing YAML/file-backed ones;
  backend is a constructor swap keyed on `DATABASE_URL`.
- **Two-layer source of truth:** committed YAML/ConfigMap = infra defaults +
  **first-boot seed**; Postgres = mutable runtime state thereafter. One-shot
  import of any existing `*.local.yaml` instances (mirrors the run-history
  migration). Schema history → rows; drop the `schema-history/` dir.
- Postgres also becomes the home for the **future app-managed data** the user
  flagged, and a later read-offload target for the knowledge graph.
- **Recommended (locked at build time): Drizzle ORM** (TypeScript-first,
  built-in migrations, pairs with the Zod already in use) and **in-cluster
  Postgres `StatefulSet` for the demo** (mirrors the Redis self-host decision,
  ~$1, learn-K8s) **→ Cloud SQL for company prod** via a `DATABASE_URL` swap.

## Alternatives Considered

- **Read-only v1 (403 on writes).** Rejected in favor of editable-ephemeral —
  the user wants the UI usable as a live scratchpad in v1, and a read-only guard
  is _more_ app code than the `emptyDir` approach (which is zero).
- **PVC + StatefulSet stopgap for v1.** Rejected — RWO PVC binds to one node,
  doesn't scale to multi-replica HA, and is throwaway work once Postgres lands.
  `emptyDir` is simpler and the demo loses nothing it wasn't going to lose.
- **GitOps as the destination (app read-only, edits via committed YAML +
  redeploy).** Rejected as the _source of truth_ — no instant self-service.
  Retained in spirit: the committed YAML/ConfigMap is the Phase-2 seed +
  infra-defaults layer.
- **Keep YAML-on-disk as the long-term store.** Rejected — doesn't scale to
  multiple replicas and the user needs a DB regardless.

## Consequences

- Amends the "**no application code changes**" stance of
  `hosting-gke-distributed-not-vercel`: Phase 1 is genuinely ~zero app change
  (infra-only), but Phase 2 is a deliberate, well-bounded app change. That
  decision rejected _bending the app to a platform_; an interface extraction +
  DB impl is the opposite — it's the app growing the persistence layer it needs.
- Adds **Postgres** to the stack at Phase 2 (new infra + new data-access layer;
  none exists today).
- api-server HA still requires the **embedded sync scheduler to be extracted**
  into its own worker before `replicas > 1` (it would double-poll otherwise).
  The DB is the foundation for that, not a substitute. Out of scope here.

## Revisit Triggers

- Phase 2 kickoff → lock Drizzle vs alternative, and in-cluster vs Cloud SQL.
- Extracting the sync scheduler for multi-replica api-server HA.
- Postgres growing to absorb KG read-offload or other app data → revisit schema
  ownership boundaries.

## Related

- [hosting-gke-distributed-not-vercel](hosting-gke-distributed-not-vercel.md) — amends its "no app code changes" consequence
- [k8s-deployment-architecture](../plans/k8s-deployment-architecture.md) — the deployment this unblocks (their D13)
- [connector-run-storage-redis-not-yaml](connector-run-storage-redis-not-yaml.md) — the store-interface precedent this design follows
- [connector-runner-injection](../patterns/connector-runner-injection.md) — same interface-swap pattern
- [etag-optimistic-concurrency-for-editable-config](etag-optimistic-concurrency-for-editable-config.md) — ETag logic the stores must preserve
