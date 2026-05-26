---
type: decision
status: active
created: 2026-05-20
updated: 2026-05-20
author: claude-opus-4-7
tags: [config, connectors, schema]
importance: core
---

# `connectors:` lives at the root of `shipit.config.yaml`, not under `backend:`

## Context

First draft of the v1 schema placed `github.app.*` and `connectors[]` under `backend:` alongside Neo4j, Redis, MCP, etc. User pushed back: connectors aren't services ShipIt **runs**, they're external systems ShipIt **reaches out to**. Different lifecycle, different ownership, different mental model.

## Decision

The Zod root schema has three top-level sections:

```yaml
backend: # Node services ShipIt runs (Neo4j, Redis, API port, MCP)
frontend: # Next.js client (api URL, devUser, integration links)
connectors: # External integrations
  github:
    app: { id, privateKeyPath, webhookSecret, webhookPublicUrl }
    rateLimits: { conditionalRequests, maxConcurrentSyncs }
  instances: [] # per-org connector entries
```

## Alternatives Considered

- **Leave under `backend.github` / `backend.connectors`**: matched the runtime topology (api-server orchestrates connectors) but conflated "infra ShipIt depends on" with "systems ShipIt consumes". Reasoning about secrets boundary was harder.
- **Per-source top-level keys (`github:`, `kubernetes:`, …)**: rejected. The namespace grows unbounded, and `instances[]` would have nowhere natural to live.

## Consequences

- Adding a new connector type (Kubernetes, Datadog, …) adds a child under `connectors.<type>:` for type defaults. The shared `connectors.instances[]` array stays one discriminated union.
- `GitHubAppService` writes `connectors.github.app.*`; `ConnectorRegistry` writes `connectors.instances[]`. Two services, two non-overlapping paths.
- The bootstrap check for "is GitHub usable" reads `config.connectors.github.app` and `config.connectors.instances.some(c => c.type === 'github' && c.app?.id)`.

## Revisit Triggers

- A connector type emerges that legitimately needs to live under `backend.*` (e.g. an in-process plugin loader that boots with the server).
- We outgrow YAML and move to SQLite — at which point this is mostly a doc-shape concern, not a runtime one.

## Related

- [github-connector-architecture-v1](./github-connector-architecture-v1.md)
- [per-org-github-app-override](./per-org-github-app-override.md) — reads `connectors.github.app` as the global fallback
