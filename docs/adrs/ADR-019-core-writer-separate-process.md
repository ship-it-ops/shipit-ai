# ADR-019: The Core Writer Runs as Its Own Process

## Status

Accepted

## Date

2026-05-22

## Context

The api-server's sync scheduler publishes connector entities onto the BullMQ event bus. Nothing consumed them: the dashboard showed zero nodes after a successful sync. The writer pipeline (`ClaimResolver → IdentityReconciler → IdempotencyChecker → NodeWriter`) existed in `packages/core-writer` but had no entry point, and `pnpm start:backend` already intended three processes (api-server, core-writer, mcp-server).

## Decision

`core-writer` is a long-lived background process, separate from the api-server. It loads the same configuration, opens its own Neo4j driver, subscribes to the event bus at `backend.redis.url`, batches envelopes and runs them through the writer pipeline. The Neo4j adapters (`node-writer.ts`, `linking-key-index.ts`, `idempotency-checker.ts` under `packages/core-writer/src/neo4j/`) belong to it; `main.ts` wires them. It exits loudly at boot if Neo4j or Redis is unreachable.

The same shape was reused twice since: `agent-runner` (ADR-034) and `knowledge-worker` (ADR-035) are long-lived workers beside the api-server, each with its own image and deployment.

## Consequences

### Positive

- Graph writes never compete with request latency; backpressure stays in the queue.
- Webhook refetches and polling both feed one stream consumer.
- Unit tests keep the in-memory adapters; production swaps only in `src/neo4j/*`.

### Negative

- One more process to run locally and deploy.
- A reader that needs strict freshness has no "writer caught up" signal yet.

### Neutral

- Scaling the writer means a worker pool on the same queue; BullMQ already supports it.

## Alternatives Considered

### Run the writer inside the api-server

- **Pros:** One process.
- **Cons:** Couples a long-running Neo4j writer to the HTTP lifecycle.

### Run the writer as a CLI per sync

- **Pros:** Simple mental model.
- **Cons:** The bus is a continuous stream; polling and webhooks emit outside any sync's lifetime.

## References

- `docs/agent/decisions/core-writer-runs-as-its-own-process.md`
- `docs/agent/scars/bullmq-5-forbids-colons-in-queue-names-and-job-ids.md`
