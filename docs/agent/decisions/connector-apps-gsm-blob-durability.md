---
type: decision
status: active
created: 2026-06-14
updated: 2026-06-14
author: claude-session-2026-06-14
tags: [connectors, secrets, gsm, durability, per-org]
importance: core
---

# Durable per-org connectors via a single GSM `connector-apps` blob

## Context

Per-org GitHub connectors (each with an `app` override + its own PEM on disk) were
not durable in prod. TWO pieces lived only on the ephemeral `/data` emptyDir and were
wiped on every pod restart/redeploy:

- the **PEM** at `/data/keys/github-app-<appId>.pem`;
- the **connector instance** itself (id, installationId, org, scope, `app` override) in
  `shipit.config.local.yaml`.

A real secret (the PEM) can't live in the committed `shipit.config.yaml` (git +
secretlint), so it must arrive from a secret store at boot. GSM previously held only a
single GLOBAL App slot — no per-connector home — and the app never creates GSM
containers (Terraform-managed).

User decision (2026-06-14, chosen over per-connector containers / Postgres-now):
**one `connector-apps` GSM blob carrying the whole per-org record** and rehydrated fully
at boot, so per-org connectors survive a restart with zero manual steps.

## Decision

- New logical secret `connector-apps` → container `shipit-connector-apps`, writable;
  no env var (it's a file-materialized blob). `secrets/types.ts`.
- New `ConnectorAppStore` (`services/connector-app-store.ts`), GSM-only:
  - `sync(connectors)`: writes the blob `{version, connectors: {id → {instance, pem?,
webhookSecret?}}}`. Reads each per-org PEM (+ webhook sidecar) from `keyDir`.
    Best-effort — a GSM failure logs and does NOT fail the mutation.
  - `loadAndMaterialize()`: writes per-org PEM/sidecar files back to `keyDir` and returns
    the instances. Returns `null` (no blob / file mode → fall back to committed config)
    vs `[]` (blob present but empty → authoritative, no resurrection).
- `ConnectorRegistry` takes an optional `durableStore` and calls `sync(this.list())` at
  the end of `persistInner()` — the single create/update/remove choke point.
- Boot (`index.ts`, normal mode): `loadAndMaterialize()` before registry construction.
  **Blob-authoritative merge**: blob present → registry `initial = rehydrated`; absent →
  `initial = committed config.connectors.instances` AND seed the blob (gsm only). Once the
  blob exists it's the source of truth — committed instances are a first-run seed only.

## Consequences

- Per-org connectors + their PEMs survive restarts automatically on gsm deployments.
- Local/file dev unchanged (the store no-ops; local fs is already durable).
- 64KB GSM version cap → ~25–30 connectors; logs a warning past 60KB.
- **Requires infra**: container `shipit-connector-apps` + api-server SA write+read IAM
  (see `docs/agent/briefs/infra-connector-apps-secret.md`). Until it exists, boot read
  returns null (no rehydrate) and `sync` logs a write failure without crashing — app-side
  ships safely first.
- Storing non-secret instance config in a GSM secret is a deliberate v1 choice (precedent:
  `auth-admin-emails`).

## Revisit Triggers

- Phase-2 Postgres config store lands → move connectors there; the blob becomes legacy.
- A deployment exceeds ~25 connectors → split per-connector containers or move to Postgres.
- Operators need to declare connectors in committed config AND mutate at runtime → revisit
  the blob-authoritative merge (today committed instances are a first-run seed only).

## Related

- [api-server-config-persistence-strategy](./api-server-config-persistence-strategy.md) — the emptyDir/ephemeral model this works around; Postgres is the eventual home
- [gsm-secret-store-and-config-export](./gsm-secret-store-and-config-export.md) — the secret taxonomy + boot hydration this extends
- [per-org-github-app-override](./per-org-github-app-override.md) — the per-org App model whose credentials this persists
- [auth-oauth-app-separate-from-connector](./auth-oauth-app-separate-from-connector.md) — same session; connector secrets are now fully separate from login
