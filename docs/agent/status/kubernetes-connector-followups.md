---
type: status
status: active
created: 2026-09-22
updated: 2026-09-22
author: claude-session-2026-09-22
branch: k8s-connector-followups
agent: claude-session-2026-09-22
tags: [connectors, kubernetes, follow-ups, api-server]
---

# Kubernetes connector v1 post-merge follow-ups + Connector Hub spec

Working the two remaining v1 threads. The infra ClusterRole brief (the third) is being
handled directly in `shipit-ai-infra` by the user — not in this repo's scope.

## Scope

- `packages/connectors/kubernetes` — `withTimeout` abort, `proxy-url` rejection,
  `PodSummary` optional fields, dead `sync()`
- `packages/api-server` — credentials-route hygiene, probe `probedNamespace`,
  connector-app-store blob carry-forward, key-dir mode
- `packages/core-writer` — share the BLAST Cypher with mcp-server in the acceptance test
- `docs/superpowers/specs/` — Spec 2 (Connector Hub wizard for Kubernetes)

Deliberately NOT in scope (scale-gated, stay in the follow-ups plan): M4 known-name
lookup `LIMIT`, and the `markAbsent` `_source_connector_id` index.

## Why

[kubernetes-connector-v1-followups](../plans/kubernetes-connector-v1-followups.md) —
the review items recorded but not implemented before #113 merged.

## Where this stands (2026-09-24)

- **Follow-ups: DONE, uncommitted** on `k8s-connector-followups`. 9 of 11 items implemented under
  TDD; full suite green (15/15 turbo tasks, build + typecheck + lint + prettier clean). Two items
  stay deferred by design (M4, `markAbsent` index — both scale-gated) and one was rejected after
  reading the flow (M5's connector-existence check would break the create path). Per-item record:
  [kubernetes-connector-v1-followups](../plans/kubernetes-connector-v1-followups.md).
  NOT verified locally: the core-writer acceptance test that now calls the real
  `generateBlastRadiusCypher` is `NEO4J_TEST_URI`-gated and Docker is unavailable here — CI's
  Integration job is where it executes.
- **Spec 2: WRITTEN, uncommitted** at
  `docs/superpowers/specs/2026-09-24-connector-hub-kubernetes-design.md`. Awaiting user review;
  no implementation started (brainstorming's gate — implementation needs its own go-ahead).
- **Infra ClusterRole brief: accepted by infra, deploying.** Handled in `shipit-ai-infra` by the
  user, not from this repo. The brief's verification probe has NOT been run yet.

## Done when

PR for the follow-ups merged into main.
