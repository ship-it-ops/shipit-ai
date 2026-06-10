---
type: decision
status: active
created: 2026-06-09
updated: 2026-06-09
author: claude-session-2026-06-09
tags: [secrets, gsm, workload-identity, onboarding, kubernetes, cross-repo, config]
importance: core
---

# GSM-backed SecretStore (boot hydration + writer-side store) and config export

## Context

The infra repo's cross-repo brief (resolving their 2026-06-09 handoff fork) asked
this app to persist onboarding-created credentials to Google Secret Manager via
the pod's Workload Identity, because everything the wizard writes today (PEM,
webhook-secret sidecar, `shipit.config.local.yaml`) lands on a GKE `emptyDir`
wiped on every pod restart. Full spec:
`docs/superpowers/specs/2026-06-09-gsm-secret-store-design.md` (approved).

## Decision

- **`SecretStore` interface in `packages/api-server/src/secrets/`** (NOT
  `packages/shared` — keeps the grpc-heavy GSM SDK out of other workspaces; see
  scar `web-ui-cannot-import-mcp-server-root`). Two impls: `FileSecretStore`
  (default, behavior-neutral) and `GsmSecretStore` (ADC only,
  `accessSecretVersion`/`addSecretVersion`, never `createSecret`). Selected via
  `SHIPIT_SECRET_STORE=file|gsm`.
- **Integration style: boot hydration + store for writers.** A gsm-only
  hydration step in `index.ts` runs BEFORE `loadConfig()` and pulls GSM values
  into `process.env` + a materialized PEM file (exports
  `GITHUB_APP_PRIVATE_KEY_PATH`), so all existing consumers
  (`server.ts` env reads, `resolveAppCredentials`/`privateKeyPath`, config
  `${ENV}` substitution) stay untouched. Only write paths use the store.
- **Contract answers to infra (Q1–Q5):** infra injects only
  `SHIPIT_SECRET_STORE=gsm` + `GOOGLE_CLOUD_PROJECT` (+
  `SHIPIT_GITHUB_APP_KEY_DIR=/data/keys`); container names hard-mapped in-app
  with `SHIPIT_GSM_SECRET_<LOGICAL>` override. Prod reads feature secrets
  directly from GSM — infra drops them from ESO (incl. the `github-app`
  PEM ExternalSecret/mount). Public IDs (App ID, OAuth client ID) get two new
  GSM containers (`shipit-github-app-id`, `shipit-github-oauth-client-id`,
  count 6→8); IAM (accessor + versionAdder) needed on **six** containers. KSA
  `api-server`/ns `shipit` acked. One PR, app repo owns it.
- **Scope:** manifest exchange also persists the conversion's
  `client_id`/`client_secret` (previously discarded — the storage path the
  github-app-manifest-flow decision's revisit trigger anticipated). GSM
  persistence is gated on `target === 'global'`: per-org (`target=instance`)
  flows perform zero GSM writes, extending the existing "instance never touches
  the global App slot" invariant to the GSM containers (review finding
  2026-06-10). OIDC is
  **UI-entry + persist** (`PUT /api/auth/providers/oidc`, admin-only), not
  RFC 7591 DCR. Bootstrap secrets (Neo4j password, session secret) stay
  operator-managed and the store refuses writes to them client-side.
- **Config export:** `GET /api/config/export` (admin-only) returns the raw
  `deepMerge(base, local)` YAML — pre-`${ENV}`-substitution so placeholders
  survive — scrubbed of `webhookSecret` + `backend.mcp.apiKeySecret` +
  `lastRuns`, for committing as the
  chart's next seed config. Credentials durable in GSM + wiring durable in the
  exported seed = a redeploy resumes where the instance left off.

## Alternatives Considered

- **Store threaded through all consumers**: rejected — turns sync boot paths
  async, changes the `privateKeyPath` contract everywhere, ~3× diff for the
  same prod behavior.
- **Read feature secrets via ESO-synced env**: rejected — up to 1h staleness
  after a wizard write; dual sources of truth.
- **Public IDs operator-set in ConfigMap**: rejected — keeps a manual step the
  wizard exists to remove.
- **OIDC Dynamic Client Registration (RFC 7591)**: rejected for scope — many
  IdPs disable DCR; UI-entry covers all of them.

## Consequences

- `@google-cloud/secret-manager` added to api-server only.
- The webhook secret finally gets a durable home before the webhook receiver
  exists (P1 open question `per-app-webhook-secrets` is unaffected).
- File mode is byte-for-byte today's behavior; the manifest service gates GSM
  persistence on `store.kind === 'gsm'`.
- Partially retires the credential subset of infra's D13 ephemeral-state scar;
  D15 (Postgres config store) unaffected — GSM holds credentials only.

## Revisit Triggers

- Webhook receiver lands → per-App webhook secrets may need more containers.
- api-server `replicas > 1` → single-writer assumption breaks.
- Postgres config store (D15) lands → config-export seed loop may retire.

## Related

- [github-app-manifest-flow](github-app-manifest-flow.md) — the wizard flow gaining the GSM write path
- [api-server-config-persistence-strategy](api-server-config-persistence-strategy.md) — the emptyDir/v1 decision this complements
- [image-build-owned-by-infra-repo](image-build-owned-by-infra-repo.md) — sibling cross-repo trust-boundary decision
- [gsm-secret-store-implementation](../plans/gsm-secret-store-implementation.md) — the implementation plan
