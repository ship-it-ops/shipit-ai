---
type: status
status: active
created: 2026-09-16
updated: 2026-09-16
author: claude-session-2026-09-16-k8s-connector
branch: k8s-connector-v1
agent: claude-session-2026-09-16-k8s-connector
tags: [connectors, kubernetes, scheduler, core-writer]
---

# Kubernetes connector v1 — design approved, implementation plan + build in progress

## Scope

- `packages/connectors/kubernetes` (new connector: auth modes, fetchers, normalizers, linking)
- `packages/shared` (kubernetes member of the connector config union; `EventEnvelope.kind`)
- `packages/event-bus` (`publishControl` for `sync.completed`)
- `packages/core-writer` (absence sweep; clear `_absent_since` on write/touch)
- `packages/api-server` (`services/connector-types/` factory; scheduler, registry, probe,
  credentials route, connector-app-store blob fields; read filters)
- `packages/mcp-server` (exclude absent nodes by default; `include_absent`)
- docs: `docs/connectors.md`, README connector table/roadmap

## Why

[kubernetes-connector-v1-design](../decisions/kubernetes-connector-v1-design.md); full spec at
`docs/superpowers/specs/2026-09-16-kubernetes-connector-design.md`. Spec 2 (Connector Hub UI)
and the infra brief (ClusterRole + chart annotation) follow separately.

## Done when

`branch k8s-connector-v1 deleted on remote` — replace with `PR #N merged` once the PR opens.
