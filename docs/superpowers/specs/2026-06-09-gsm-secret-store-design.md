# Design: GSM-backed dynamic secrets for onboarding

**Date:** 2026-06-09
**Status:** approved
**Driver:** cross-repo brief from `Ship-It-Ops/shipit-ai-infra` — "app-side dynamic GSM
secrets (onboarding persists its own credentials)". Resolves the infra handoff's open
secrets fork: today the GKE secret pipeline is read-only (operator hand-uploads six
values to Google Secret Manager per `scripts/bootstrap-secrets.md`), and credentials
minted by the onboarding wizard land on an `emptyDir` that is wiped on every pod
restart.

## Goal

The onboarding UI persists the credentials it creates directly into Google Secret
Manager (GSM), authenticating with the pod's own Workload Identity, so:

- wizard-created credentials survive pod restarts (Spot-node preemption is routine);
- the operator never hand-uploads the four feature secrets or the two public IDs;
- local/dev behavior is byte-for-byte unchanged (`SHIPIT_SECRET_STORE=file` default).

## Settled contract decisions (Q1–Q5 from the infra brief)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | Infra injects only `SHIPIT_SECRET_STORE=gsm` + `GOOGLE_CLOUD_PROJECT`. Logical→container names are hard-mapped in the app to the Terraform names, each overridable via optional `SHIPIT_GSM_SECRET_<LOGICAL_NAME>` env.                                                                                                                                                                       |
| Q2  | In prod the app reads feature secrets **directly from GSM** at boot (and sees its own writes immediately in-process). Infra drops the four feature secrets from the `shipit-app-secrets` ExternalSecret and drops the `github-app` ExternalSecret/PEM mount entirely. Chart no longer sets `GITHUB_APP_PRIVATE_KEY_PATH`; it sets `SHIPIT_GITHUB_APP_KEY_DIR=/data/keys` (writable emptyDir). |
| Q3  | Public IDs persist in GSM too — two new containers `shipit-github-app-id` and `shipit-github-oauth-client-id` (active count 6→8), same read+addVersion IAM. ConfigMap `GITHUB_APP_ID`/`GITHUB_OAUTH_CLIENT_ID` become optional fallbacks.                                                                                                                                                     |
| Q4  | KSA `api-server` in namespace `shipit` — acknowledged; the app has no assumption about the KSA name.                                                                                                                                                                                                                                                                                          |
| Q5  | One PR, owned by the app repo. Scope note for infra: IAM (`roles/secretmanager.secretAccessor` + `roles/secretmanager.secretVersionAdder`) is needed on **six** containers — 4 feature + 2 public-ID — not four.                                                                                                                                                                              |

Additional scope decisions made with the operator:

- **GitHub OAuth client credentials are wizard-created.** The GitHub App manifest
  conversion already returns `client_id`/`client_secret` (currently discarded); the
  exchange now persists them via the store.
- **OIDC is UI-entry + persist.** The operator registers the client in their IdP as
  today, but pastes issuer URL + client ID + client secret into an admin settings
  form; the app persists the secret to GSM. No RFC 7591 Dynamic Client Registration.
- **Integration style: boot hydration + store for writers.** Existing consumers
  (`server.ts` env reads, `resolveAppCredentials`/`privateKeyPath` plumbing, config
  `${ENV}` substitution) stay unchanged; a single hydration step at boot pulls GSM
  values into the places the app already reads them. Only write paths use the store
  directly.

## Secret taxonomy

**Bootstrap — operator pre-loads, app READS only (store refuses writes client-side):**

| Logical               | GSM container                | Consumed as                                    |
| --------------------- | ---------------------------- | ---------------------------------------------- |
| `neo4j-aura-password` | `shipit-neo4j-aura-password` | `NEO4J_PASSWORD` (stays ESO-synced env)        |
| `session-secret`      | `shipit-session-secret`      | `SHIPIT_SESSION_SECRET` (stays ESO-synced env) |

**Feature — onboarding creates, app WRITES + reads back:**

| Logical                      | GSM container                       | Consumed as                      |
| ---------------------------- | ----------------------------------- | -------------------------------- |
| `github-app-private-key`     | `shipit-github-app-private-key`     | PEM file materialized to key dir |
| `github-webhook-secret`      | `shipit-github-webhook-secret`      | `GITHUB_WEBHOOK_SECRET`          |
| `github-oauth-client-secret` | `shipit-github-oauth-client-secret` | `GITHUB_OAUTH_CLIENT_SECRET`     |
| `oidc-client-secret`         | `shipit-oidc-client-secret`         | `OIDC_CLIENT_SECRET`             |

**Public IDs — onboarding creates, app WRITES + reads back (not secret, but need a durable home):**

| Logical                  | GSM container                   | Consumed as              |
| ------------------------ | ------------------------------- | ------------------------ |
| `github-app-id`          | `shipit-github-app-id`          | `GITHUB_APP_ID`          |
| `github-oauth-client-id` | `shipit-github-oauth-client-id` | `GITHUB_OAUTH_CLIENT_ID` |

The app never calls `createSecret` — all containers are Terraform-managed.

## Architecture

New module in **`packages/api-server/src/secrets/`** (NOT `packages/shared`):
api-server is the only reader/writer of feature secrets, and keeping the grpc-heavy
`@google-cloud/secret-manager` dependency out of `shared` keeps it out of
core-writer/mcp-server/web-ui builds (see scar `web-ui-cannot-import-mcp-server-root`).

```text
packages/api-server/src/secrets/
  types.ts        SecretStore interface, LogicalSecret union, errors
  file-store.ts   FileSecretStore — today's behavior (disk PEM/sidecar, process.env)
  gsm-store.ts    GsmSecretStore — accessSecretVersion(latest) / addSecretVersion, ADC
  hydrate.ts      boot-time hydration (gsm only)
  index.ts        makeSecretStore(env) factory keyed on SHIPIT_SECRET_STORE
```

### SecretStore interface

- `read(name: LogicalSecret): Promise<string | null>` — `null` when unset/empty.
- `write(name: LogicalSecret, value: string): Promise<void>` — throws
  `SecretWriteForbiddenError` for bootstrap secrets before IAM would deny it.
- Values are exact UTF-8 strings; **no trailing-newline normalization anywhere**. The
  PEM must round-trip byte-for-byte (GSM → file mount contract). The webhook-secret
  sidecar file keeps its trailing `\n` for shell `$(cat …)` ergonomics, but the GSM
  value is written **without** it.
- `GsmSecretStore` resolves the container name as
  `env[SHIPIT_GSM_SECRET_<LOGICAL_NAME>] ?? hardcodedDefault`, project from
  `GOOGLE_CLOUD_PROJECT`, credentials via ADC only (GKE metadata server — no JSON
  key files). Client constructed lazily; injectable for tests (same seam pattern as
  `fetchImpl` in the manifest service).

### Boot hydration (gsm only)

In `packages/api-server/src/index.ts`, **before `loadConfig()`**:

1. Read the four feature secrets + two public IDs from GSM.
2. Materialize the PEM to `${SHIPIT_GITHUB_APP_KEY_DIR}/github-app-<id>.pem`
   (mode 0600; `/data/keys` on GKE — writable emptyDir).
3. Export into `process.env` (only when non-null and not already set by the
   environment): `GITHUB_WEBHOOK_SECRET`, `GITHUB_OAUTH_CLIENT_SECRET`,
   `OIDC_CLIENT_SECRET`, `GITHUB_APP_ID`, `GITHUB_OAUTH_CLIENT_ID`, and
   `GITHUB_APP_PRIVATE_KEY_PATH` (pointing at the just-materialized PEM) so the
   chart-seeded config's `${GITHUB_APP_PRIVATE_KEY_PATH:-}` substitution resolves
   `connectors.github.app.privateKeyPath` to it.
4. `loadConfig()` then resolves `${GITHUB_APP_ID:-}`-style substitutions in the
   chart-seeded config exactly as today; `server.ts` reads
   `process.env[clientSecretEnv]` exactly as today.

Absent secrets hydrate as "not set" → first boot lands in the onboarding wizard,
same as today. With `SHIPIT_SECRET_STORE=file` (default) hydration is a no-op and
nothing about local dev changes.

### Write paths

**GitHub App manifest exchange** (`github-app-manifest-service.ts`,
`exchangeAndPersist`): keeps writing the PEM + webhook-secret sidecar to disk
(local UX unchanged), and additionally — when the store supports writes (gsm)
**and the exchange targets the global App slot** — persists:

- `github-app-private-key` ← exact `payload.pem`
- `github-webhook-secret` ← `payload.webhook_secret`
- `github-oauth-client-secret` ← `payload.client_secret` (currently discarded)
- `github-app-id` ← `payload.id`
- `github-oauth-client-id` ← `payload.client_id` (currently discarded)

After each successful write, update `process.env` in-process so the running pod
sees the values immediately (no ESO round-trip — ESO no longer carries feature
secrets at all per Q2). GSM write failures surface on the wizard error page with
the container name; the on-disk copy still exists so the operator can recover
manually.

**Instance-target gating (review finding, 2026-06-10):** per-org manifest flows
(`target=instance`) perform **zero** GSM writes. The global GSM containers mirror
the global App slot, and the existing invariant ("instance target never touches
the global slot" — decision `github-app-manifest-flow`, target-routing extension)
extends to them: writing an instance App's credentials to `shipit-github-app-*`
would silently replace the shared App's credentials at the next boot hydration.
Durable per-org App credentials are out of scope for v1 (would need per-instance
containers).

**OIDC settings** — new authenticated admin endpoint (`PUT
/api/auth/providers/oidc`, admin-gated like the other config-mutating routes) plus
a small settings form: issuer URL, client ID, client secret. The secret goes to
`store.write('oidc-client-secret')` + `process.env`; issuer URL and client ID
persist via the existing config-service/local-YAML pattern. Auth providers are
constructed at boot, so the form's success state says changes take effect on
restart — and on GKE a restart re-hydrates everything from GSM, which is the
point.

## Config export

GSM makes the _credentials_ durable, but everything else the app writes at runtime
(connector instances, scope config, the App ID + `privateKeyPath` wiring, schema
edits' sibling `*.local.yaml` changes, OIDC issuer/client ID) still lives in the
`emptyDir` and reverts to the committed seed on every pod restart. The escape
hatch: the app can **export its current effective config** so the operator commits
it into the infra repo as the chart's next ConfigMap seed — the next deploy then
boots exactly where this one left off.

- **Endpoint:** `GET /api/config/export` (admin-gated), returns YAML with
  `Content-Disposition: attachment; filename="shipit.config.yaml"`. A small
  "Export config" button in the web-UI settings/connectors area downloads it.
- **Source: the raw files, not the resolved config.** The export is
  `deepMerge(base YAML, local YAML)` of the on-disk files _before_ `${ENV}`
  substitution — placeholders like `${GITHUB_APP_ID:-}` survive into the seed
  instead of being baked to today's values, and Zod-default noise isn't
  serialized in.
- **Scrubbing:** drop `connectors.github.app.webhookSecret` (config holds env-var
  _names_, never secret values — this field should always be empty, but the export
  fails closed), drop `backend.mcp.apiKeySecret` (a literal secret value the
  shipped config tells operators to set in the local file — review finding
  2026-06-10), and drop per-connector `lastRuns` (runtime history, not config;
  run history lives in Redis anyway).
- A header comment in the exported YAML records the export timestamp and source
  ("exported from running instance — commit as the chart's seed config").

## Error handling

- `SHIPIT_SECRET_STORE=gsm` without `GOOGLE_CLOUD_PROJECT` → fail boot with a
  clear message. ADC/permission failures during hydration → fail boot loudly
  (misconfigured Workload Identity must not silently boot an empty instance).
- A _missing_ secret (no version yet) is not an error — it's first-run.
- Bootstrap-secret writes throw `SecretWriteForbiddenError` client-side.
- Single-writer assumption (api-server `replicas: 1` is load-bearing infra-side);
  no concurrent-writer reconciliation.

## Testing

TDD throughout (house style):

- `FileSecretStore`: env/file resolution matches today's behavior.
- `GsmSecretStore`: read/write against a mocked client; container-name override
  env; bootstrap write refusal; missing-version → `null`.
- Hydration: present/absent secrets; PEM byte-exactness round-trip (incl. no
  trailing-newline mangling); does-not-clobber pre-set env vars.
- Manifest service: exchange now persists the five values via an injected store;
  GSM-write-failure path renders the error with container name; `file` mode
  behavior unchanged.
- OIDC settings endpoint: validation, admin gating, persistence split
  (secret→store, identifiers→config).
- Config export: merge of base+local raw YAML; `${ENV}` placeholders preserved
  (not substituted); `webhookSecret`/`lastRuns` scrubbed; admin gating.

## Non-goals

- No RFC 7591 OIDC Dynamic Client Registration.
- No webhook-receiver work (`GITHUB_WEBHOOK_SECRET` still has no consumer; this PR
  just gives it a durable home).
- No change to bootstrap-secret delivery (Neo4j password, session secret stay
  ESO-synced).
- No multi-replica/concurrent-writer support.
- No Postgres config store (D15 direction unaffected; GSM holds credentials only).

## Cross-repo follow-ups for infra

1. Add `shipit-github-app-id` + `shipit-github-oauth-client-id` containers.
2. Grant the `shipit-api-server` GSA accessor + versionAdder on the **six**
   app-writable containers (not four).
3. Drop the four feature secrets from `shipit-app-secrets` ExternalSecret; drop the
   `github-app` ExternalSecret and `/secrets` PEM mount; stop setting
   `GITHUB_APP_PRIVATE_KEY_PATH`.
4. Set `SHIPIT_SECRET_STORE=gsm`, `GOOGLE_CLOUD_PROJECT`, and
   `SHIPIT_GITHUB_APP_KEY_DIR=/data/keys` on the api-server pod; bind KSA
   `api-server`/ns `shipit` to the new GSA.
5. `scripts/bootstrap-secrets.md` shrinks to the two bootstrap secrets.
6. Document the config-export loop in the deploy runbook: after meaningful
   onboarding/config changes, download `GET /api/config/export` and commit it as
   the chart's seed `shipit.config.yaml` so the next deploy resumes from it (no
   chart-template change needed — it's the same seed file D13 already mounts).
