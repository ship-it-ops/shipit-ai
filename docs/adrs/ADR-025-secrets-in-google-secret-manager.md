# ADR-025: Credentials Live in Google Secret Manager — Boot Hydration, a Writer-Side Store, and the Connector Blob

## Status

Accepted

## Date

2026-06-09 (connector blob: 2026-06-14)

## Context

Everything the setup and connector wizards write — the App private key, the webhook secret, the OAuth client, connector instances — landed on the ephemeral volume of ADR-024. A real secret cannot live in the committed config, so it has to arrive from a secret store at boot and go back to one when the wizard creates it.

## Decision

- A `SecretStore` interface in the api-server (`packages/api-server/src/secrets/`) with two implementations: `FileSecretStore` (the default; local behaviour unchanged) and `GsmSecretStore` (application default credentials; adds versions, never creates containers). Selected with `SHIPIT_SECRET_STORE=file|gsm`.
- **Boot hydration:** before the configuration loads, the GSM store pulls each logical secret into `process.env` (and materialises the App key as a file), so every existing consumer reads what it always read. A value already present in the environment skips the read.
- **Only write paths use the store:** the manifest exchange, the setup wizard, the OIDC settings. Bootstrap secrets (the Neo4j password, the session secret) stay operator-managed and the store refuses to write them.
- A **config-driven secrets registry** declares every logical secret, its container name and whether the app may write it; infrastructure creates the containers and grants access.
- **Per-org connectors are durable through one `connector-apps` blob:** the whole record of each per-org connector (instance, key, webhook secret) is written to one secret on every registry mutation and rehydrated at boot. Once the blob exists it is the source of truth; committed instances are a first-run seed only.
- `GET /api/config/export` (admin) returns the merged configuration with secrets scrubbed, for committing as the next seed.

## Consequences

### Positive

- A redeploy resumes where the instance left off: credentials durable in the secret store, wiring durable in the exported seed.
- The connector flow never writes the global App slot from a per-org creation.

### Negative

- Every new logical secret needs a container and an IAM grant on the infrastructure side before the image that uses it deploys; a missing container crashes boot hydration.
- A disabled or destroyed latest version also fails hydration; "empty" means an empty version.
- The blob caps at the secret size limit (roughly 25–30 connectors).

### Neutral

- Storing non-secret connector configuration in a secret is a deliberate interim choice until the Postgres config store.

## Alternatives Considered

### Thread the store through every consumer

- **Cons:** Turns synchronous boot paths asynchronous for the same production behaviour.

### Read feature secrets through the cluster's secret sync

- **Cons:** Up to an hour of staleness after a wizard write; two sources of truth.

### One secret container per connector

- **Cons:** The app cannot create containers; a blob needs none.

## References

- `docs/agent/decisions/gsm-secret-store-and-config-export.md`, `connector-apps-gsm-blob-durability.md`
- `docs/superpowers/specs/2026-06-09-gsm-secret-store-design.md`, `docs/superpowers/specs/2026-07-01-config-driven-secrets-registry-design.md`
- `docs/agent/investigations/deploy-e30da0f-boot-crash-gsm-read-of-eso-delivered-secrets.md`
