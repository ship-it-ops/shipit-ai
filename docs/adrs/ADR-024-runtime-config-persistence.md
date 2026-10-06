# ADR-024: Runtime Configuration Persistence — Ephemeral Volume First, Postgres Next

## Status

Accepted (phase 2 began with ADR-034 on 2026-10-01)

## Date

2026-06-07

## Context

Three api-server write paths did not survive the move from Docker Compose to Kubernetes: the live schema file and its `schema-history/`, the GitHub App key directory, and `shipit.config.local.yaml` (connector instances). A pod's filesystem is disposable and a ConfigMap mount is read-only, so a schema save would fail outright, not merely fail to persist. The codebase had no SQL store at the time.

## Decision

A two-phase strategy behind one store-interface backbone.

- **Phase 1 (shipped with the first deployment):** the committed config and schema are mounted read-only as the seed; an init container copies them into a writable `emptyDir`; the api-server runs with `SHIPIT_CONFIG` pointing into it. Edits succeed and are lost on any pod restart. The api-server is a single-replica Deployment with no persistent volume.
- **Phase 2:** Postgres becomes the source of truth for mutable runtime state, reached by extracting store interfaces (`ConnectorConfigStore`, `SchemaStore`) in the pattern ADR-020 set, with the committed YAML as the first-boot seed. Postgres arrived with the agent platform (ADR-034); the config stores themselves are still to be extracted.

In the meantime, what must survive restarts went to Google Secret Manager (ADR-025): credentials, the first admin, and the per-org connector records.

## Consequences

### Positive

- Phase 1 needed no application change and keeps the UI usable as a live scratchpad.
- The interface extraction is a bounded application change, not a bend toward a platform.

### Negative

- Until phase 2 lands, schema and connector edits that are not covered by the secret store revert on restart.
- The api-server cannot run more than one replica until the embedded sync scheduler is extracted.

### Neutral

- Postgres is now part of the stack for agents and knowledge; moving configuration there is a matter of sequencing.

## Alternatives Considered

### Read-only in production (refuse edits)

- **Cons:** More code than the ephemeral volume, and no self-service.

### A persistent volume for the api-server

- **Cons:** Binds to one node, does not scale to replicas, and is throwaway once Postgres lands.

## References

- `docs/agent/decisions/api-server-config-persistence-strategy.md`
- ADR-020, ADR-025, ADR-034
