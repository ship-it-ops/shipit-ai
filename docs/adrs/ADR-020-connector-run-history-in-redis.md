# ADR-020: Connector Run History Lives in Redis, Not in Configuration

## Status

Accepted

## Date

2026-05-24

## Context

The connector registry persisted the last twenty sync runs of each connector inside `shipit.config.local.yaml`. Every poll rewrote the whole YAML through a Zod re-validation, a document round trip and an atomic rename: operational telemetry in a user-edited file, hundreds of writes a day, and a `lastRuns` field that leaked into the example config and the schema.

## Decision

Run history moves to a Redis-backed `ConnectorRunStore`: one list per connector (`shipit:connector-runs:<id>`, newest first, capped at twenty). The registry takes the store in its constructor (an in-memory implementation for tests), routes hydrate `lastRuns` from it, and the configuration ETag covers configuration only. Deleting a connector clears its history.

## Consequences

### Positive

- The local config holds only user-authored settings and stops churning.
- History survives api-server restarts (Redis is already a hard dependency).
- The "interface, default fake, production swap" pattern set here is reused by later stores.

### Negative

- History does not survive a volume wipe of Redis.
- Cross-connector queries ("every failed run today") are not indexed.

### Neutral

- Redis is also the session store and the queue broker; its memory limit matters (see the Redis scars under `docs/agent/scars/`).

## Alternatives Considered

### Neo4j `_SyncRun` nodes

- **Pros:** One store.
- **Cons:** Operational metrics inside the domain graph.

### Derive history from BullMQ jobs

- **Pros:** No new store.
- **Cons:** Job retention serves the queue, not a run log.

## References

- `docs/agent/decisions/connector-run-storage-redis-not-yaml.md`
- `packages/api-server/src/services/connector-run-store.ts`
