---
type: plan
status: active
created: 2026-09-22
updated: 2026-09-22
author: claude-session-2026-09-22
tags: [connectors, kubernetes, follow-ups, core-writer, api-server]
importance: standard
---

# Kubernetes connector v1 — post-merge follow-ups

## Goal

Close the non-blocking items the whole-branch review of the Kubernetes connector recorded but
deliberately did not implement. PR #113 merged on 2026-09-17 (commit 7647893) without them;
none blocks anything shipped.

## Approach

Opportunistic — take each item the next time its file is touched, except the two that are
gated on scale (M4, `markAbsent` index), which wait for a real org / graph growth.

## Items

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

## Status

Done on `k8s-connector-followups` (2026-09-22), all under TDD, full suite green
(15/15 turbo tasks, build + typecheck + lint + prettier clean):

- **M2 — `withTimeout` now aborts.** It takes `(signal) => Promise<T>` and aborts the signal on
  the deadline; `abortable(signal)` carries it into the generated client through a `pre`
  middleware calling `RequestContext.setSignal` (the only seam client-node exposes). Every
  list/get call site threads it. The probe's overall budget is the one exception — it wraps a
  sequence of individually-abortable calls, so its signal is unused by design.
- **M5 — credential files no longer outlive their connector.** `DELETE /api/connectors/:id`
  removes the credential files that no surviving connector references, under the same key-dir
  containment rule as the write sink. A failed unlink logs and never fails the delete.
- **M7 — the acceptance test runs the real generator.** `@shipit-ai/mcp-server` now exposes
  `./cypher`; `cross-source.integration.test.ts` calls `generateBlastRadiusCypher` instead of a
  hand-kept copy. NOTE: that suite is `NEO4J_TEST_URI`-gated and was only typechecked locally
  (no Docker) — CI's Integration job is where it actually executes.
- **M9 — key dir mode.** New `secrets/key-dir.ts#ensureKeyDir` chmods an existing directory to
  0700 (mkdir's `mode` applies only at creation and is umask-masked). Used by the credentials
  route, connector-app-store and boot hydration.
- **`PodSummary.restarts`/`readyPods` are optional.** Undefined when no rollup ran (CronJob, or
  pods/replicasets denied); `compact()` drops them, so a crash-looping workload no longer reads
  as `restarts: 0` as if measured.
- **`sync()` marked `@internal`, not deleted** — `ShipItConnector` requires it, so removing it
  would break the interface contract. The comment names `ConnectorHarness.runSync` as the real path.
- **`proxy-url` rejected at validation** with a message naming the field, instead of passing
  validation and failing later as an opaque `API_UNREACHABLE`. Documented in `docs/connectors.md`.
- **Probe reports `probedNamespace`** and the docs now say the per-kind verdict is measured
  against one namespace, not the cluster.

### Deliberately not done

- **M5's other half — "check `connectorId` refers to an existing connector" on
  `POST /kubernetes/credentials`.** Rejected after reading the flow: the upload route exists to
  mint paths that a _subsequent_ `POST /api/connectors` references, so the connector cannot
  exist yet. Adding the check would break the create path for every new connector. The real
  leak it was pointing at — files outliving their connector — is closed by the DELETE cleanup
  above.
- **M4 (`LIMIT` on `lookupRepositoryNames`/`lookupTeamSlugs`)** and **the `markAbsent`
  `_source_connector_id` index** — both scale-gated, unchanged, still waiting on a real org /
  graph growth. The index ties to
  [neo4j-no-indexes-declared](../open-questions/neo4j-no-indexes-declared.md).

Two remaining v1 threads outside this list:

- **Infra**: the read-only ClusterRole + `shipit.ai/github-repo` annotations brief
  (`docs/agent/briefs/infra-k8s-reader-clusterrole.md`) is being handled directly in
  `shipit-ai-infra` by the user, not from this repo.
- **Spec 2**: the Connector Hub wizard for Kubernetes.

## Related

- [kubernetes-connector-v1-design](../decisions/kubernetes-connector-v1-design.md) — the design these came out of
- [neo4j-no-indexes-declared](../open-questions/neo4j-no-indexes-declared.md) — gates the `markAbsent` index item
