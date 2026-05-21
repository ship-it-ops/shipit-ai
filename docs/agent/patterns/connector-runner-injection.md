---
type: pattern
status: active
created: 2026-05-20
updated: 2026-05-20
author: claude-opus-4-7
tags: [connectors, scheduler, testing, bullmq]
importance: standard
---

# `ConnectorRegistry` holds a `ConnectorRunner`; the scheduler is the production implementation

## When to Use

Whenever a stateful service (registry, store, manager) needs to delegate execution to an optional infrastructure dependency (BullMQ + Redis here). The interface keeps the registry test-friendly while the production wiring lives in a separate class.

## Implementation

The contract lives in `packages/api-server/src/services/connector-registry.ts`:

```ts
export interface ConnectorRunner {
  start(connector: GitHubConnectorConfig): Promise<void>;
  stop(connectorId: string): Promise<void>;
  triggerSync(
    connector: GitHubConnectorConfig,
    mode: 'full' | 'incremental',
  ): Promise<SyncRuntimeStatus>;
  getStatus(connectorId: string): SyncRuntimeStatus;
}
```

Two implementations live in the same package:

- **`NoopRunner`** (inside `connector-registry.ts`) — default. Tracks status in an in-memory `Map`, `triggerSync` instantly resolves to `state: 'idle'`. The CRUD-only test suite uses this, no Redis required.
- **`SyncScheduler`** (`packages/api-server/src/services/sync-scheduler.ts`) — BullMQ-backed. Queue + Worker per process; concurrency from `connectors.github.rateLimits.maxConcurrentSyncs`. Constructs a fresh `GitHubConnector` + `ConnectorHarness` per job. Records each run's outcome via `registry.recordRun()`.

Boot wiring lives in `packages/api-server/src/index.ts`:

```ts
const connectorRegistry = new ConnectorRegistry({ localConfigPath, initial });
// Default runner = Noop. Production swap happens only if we have credentials + Redis.
if (hasAnyGitHubConfig && config.backend.redis.url) {
  const scheduler = new SyncScheduler({ /* … */, globalApp: gh });
  (connectorRegistry as unknown as { runner: SyncScheduler }).runner = scheduler;
}
```

The cast is intentional — the field is private to discourage outside mutation; only the boot code reaches past the wrapper to swap. Don't soften the access modifier; the cast advertises that this is an exception.

## Examples

- `packages/api-server/src/__tests__/routes/connectors.test.ts` — instantiates `ConnectorRegistry` directly without a runner; the default Noop handles all 25 tests.
- `packages/api-server/src/index.ts:50-80` — production wiring with the BullMQ swap.

## Gotchas

- **Pass live references, not copies**, when the runner holds config it cares about. `globalApp: gh` (the live `config.connectors.github.app` reference) lets `GitHubAppService` mutate that object and have the scheduler pick up the new credentials without a restart. See [live-reference-for-hot-reload](./live-reference-for-hot-reload.md).
- **Per-job credential resolution, not constructor-cached**. Early draft cached `appId` + `privateKey` at constructor time. Per-org override requires resolving per job — the scheduler now calls `resolveAppCredentials(connector, this.globalApp)` inside `processJob` and reads the PEM through a path-keyed cache (one read per unique file per process).
- **Auth failure recording**: 401/403 from GitHub mark the connector `degraded` instead of `failed`, so the UI flags it without burying it. Sticky until the next successful run.
- **Webhook receiver lands in P1.** Right now the scheduler only handles polling-triggered jobs. When webhooks land, route them through `connector.handleWebhook()` and recordRun the outcome the same way.
