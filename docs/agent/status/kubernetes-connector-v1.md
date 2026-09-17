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

# Kubernetes connector v1 — implementation complete on branch, awaiting review/PR

All 13 tasks (connector package, shared schema, event-bus control envelope, core-writer
absence sweep, api-server connector-type factory + credentials + probe, docs) are committed
on `k8s-connector-v1`. Nothing has been pushed or opened as a PR yet.

A whole-branch review (`.superpowers/sdd/2026-09-16-kubernetes-connector/final-review.md`) and
its fix wave (`final-fix-brief.md` → `final-fix-report.md`) have also landed on the branch:
the connector's link diagnostics moved to a separate notes channel so they no longer degrade
every run to `partial` and disable the sweep, the sweep gained a confirmation floor plus a
same-batch failure skip, and the absent filter reached `find_owners`, `graph_stats`,
`entity_detail` and the team ownership reads. Remaining items are listed below.

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

Plan: `docs/superpowers/plans/2026-09-16-kubernetes-connector.md`.

## Done when

PR #113 merged into main (https://github.com/ship-it-ops/shipit-ai/pull/113).

## Follow-ups (post-merge)

Recorded by the final fix wave, deliberately NOT implemented in it. None blocks the merge.

- **M2 — `withTimeout` never aborts.** `fetchers/common.ts` races a timer against the call but
  the timed-out request keeps running and holding its socket. Thread an `AbortSignal` through
  to the client when that file is next touched.
- **M4 — known-name lookups have no `LIMIT`.** `api-server/src/index.ts`
  `lookupRepositoryNames` / `lookupTeamSlugs` scan by `_source_org` once per connector build
  (so once per sync job). Fine at demo scale; bound it before a large org lands.
- **M5 — credentials route hygiene.** `POST /kubernetes/credentials` does not check that
  `connectorId` refers to an existing connector, and `DELETE /:id` does not remove the
  credential files it wrote. The GSM blob self-heals from `registry.list()`, so this is disk
  hygiene, and it matches the pre-existing PEM behaviour.
- **M7 — BLAST Cypher duplicated in the acceptance test.** `cross-source.integration.test.ts`
  hand-maintains a copy of `mcp-server`'s `generateBlastRadiusCypher`, so it cannot catch a
  divergence in the real generator. Export a shared constant.
- **M9 — key dir mode not tightened when pre-existing.** `mkdirSync(dir, { mode: 0o700 })` does
  not change an existing looser directory (and `mode` is umask-masked). The per-file chmod in
  `writeSecretFile` covers the files, so this is defence in depth.
- **`PodSummary.restarts` / `readyPods` should be optional.** They report `0` when no rollup
  ran (a CronJob, or pods/replicasets denied), so a crash-looping workload reads as
  `restarts: 0` as if it were fact. Make them optional and let `compact()` drop them.
- **`KubernetesConnector.sync()` is dead code on the scheduler path.** `ConnectorHarness.runSync`
  drives `authenticate`/`discover`/`fetch`/`normalize` itself. Delete `sync()` or mark it
  `@internal`.
- **`proxy-url` kubeconfigs validate and then fail `API_UNREACHABLE`.** The cluster allowlist
  drops the field, so a proxy-only kubeconfig passes validation and fails at connect time.
  Name `proxy-url` in the rejected-fields list in `docs/connectors.md`, or reject it at
  validation time with a clear message.
- **GSM blob sync drops a stored secret when its file is missing.** `connector-app-store.sync()`
  rebuilds `blob.connectors` wholesale, so an absent credential file at sync time removes the
  previously-stored secret from GSM instead of preserving it. Carry the existing blob value
  forward and `logger.warn`. Identical pre-existing shape for `pem`.
- **Probe should report `probedNamespace`.** It measures per-kind access against
  `namespaces[0]` only but presents as cluster-wide. Say so in the response and in
  `docs/connectors.md`.
- **`markAbsent` needs a `_source_connector_id` index before large graphs.** It is a label-less
  full scan, now on a 5-minute cadence (the Kubernetes default `schedule`). Ties to the parked
  [neo4j-no-indexes-declared](../open-questions/neo4j-no-indexes-declared.md) question; revisit
  them together.
