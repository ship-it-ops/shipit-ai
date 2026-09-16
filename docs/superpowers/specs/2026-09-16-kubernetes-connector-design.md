# Kubernetes connector v1 — design

**Date:** 2026-09-16
**Status:** Approved (design), pending implementation plan
**Scope split:** this document is **Spec 1 (backend core + infra brief)**. The Connector Hub
UI is **Spec 2**, outlined at the end and written separately once Spec 1 is planned.
**Plan lineage:** Phase 1b deliverable 1 in `docs/adrs/ADR-003-phase1-mvp-scope.md` and
Task 13 in `docs/plans/2026-02-28-shipit-ai-phase1.md`.

## Problem

GitHub is the only data source. Every multi-source mechanism the platform is built around —
PropertyClaims with per-source confidence, the resolver strategies, the Reconciliation
review queue, the four-node service model — is exercised against a single source, so none
of it has been proven on real conflicts. Blast radius stops at the repository layer because
nothing in the graph describes what is actually running. `packages/connectors/kubernetes`
is a two-line scaffold, the README still says "planned", and the Add-connector picker shows
Kubernetes as "Coming soon".

Two structural gaps surfaced while designing this and are fixed here because the connector
cannot be correct without them:

1. **Nothing ever removes a node.** The core-writer only creates or merges. GitHub marks
   archived repositories with a property. Kubernetes workloads churn daily, so a
   Kubernetes connector without an absence mechanism fills the catalog with dead workloads
   within days.
2. **Nothing emits `LogicalService`.** Incident Mode and the service views walk
   `LogicalService -IMPLEMENTED_BY-> Repository` and `LogicalService -DEPLOYED_AS->
Deployment`. With no `LogicalService` nodes those panels stay empty even after
   Deployments exist.

## Goal

A Kubernetes connector instance, created through the existing connector registry and run by
the existing scheduler, reads a cluster read-only and populates `Cluster`, `Namespace`,
`Environment`, `Deployment`, `BuildArtifact` and `LogicalService` nodes with the edges that
tie a running workload back to its GitHub repository and owning team — so that
`blast_radius` from a repository reaches its deployments, and a workload that disappears
from the cluster disappears from default views after the next successful sync.

## Non-goals

- **Watch / informers.** v1 polls on the existing BullMQ scheduler. The connector keeps a
  per-resource `refetchWorkload()` seam so a later watch or webhook layer reuses
  `normalize()` exactly as the GitHub webhook path does.
- **Hard deletes or retention.** Absent nodes stay in the graph, hidden by default.
- **OCI image-label provenance.** `org.opencontainers.image.source` lives in the image
  config and needs registry credentials to read. Out of v1.
- **Argo CD / Flux CRDs as link signals.** Planned as an additional tier in v1.1.
- **`RuntimeService` nodes, Kubernetes `Service`/`Ingress` as nodes, ConfigMaps, Secrets,
  Events, raw Pods.** Services/Ingress may become Deployment properties later; the rest is
  noise or a liability.
- **Multi-cluster in one instance.** One connector instance per cluster, mirroring one
  GitHub instance per org.
- **Simple-mode service model** (ADR-011). Full model only, as everywhere else today.
- **Wizard UI.** Spec 2.

## Decisions (from brainstorming, 2026-09-16)

| #   | Decision                                                                                                   | Rationale                                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Both access paths in v1**: in-cluster ServiceAccount **and** uploaded credentials (kubeconfig or token). | In-cluster proves the demo with zero stored secrets; uploaded credentials cover any reachable cluster and local dev.       |
| 2   | **Poll on the existing scheduler**, default every 5 minutes, full list per run.                            | Reuses harness, run history and status UI unchanged. A watch needs a long-lived process the platform does not have.        |
| 3   | **Mark absent via an end-of-sync sweep**, no hard delete.                                                  | Keeps history and anything an agent cited moments ago; generic; per-type opt-in (`sweepsAbsent`), GitHub off in v1.        |
| 4   | **Tiered repository linking with confidence**: explicit annotation > image-name match > app-label match.   | Works on the demo out of the box; operators can pin the truth with one annotation.                                         |
| 5   | **Full Connector Hub wizard mirroring GitHub** (Spec 2).                                                   | Uploaded credentials need a real UI path; the demo must show the feature.                                                  |
| 6   | **Connector-type registry (factory)** in the api-server instead of GitHub branches in five places.         | Third connector becomes an additive module.                                                                                |
| 7   | **Emit `LogicalService`** per app from the connector.                                                      | Only way the existing service-centric UI and `OWNS` semantics light up; global id lets later sources merge by primary key. |

## Architecture & data flow

```
BullMQ repeat job (cron per instance)          POST /api/connectors/probe
        |                                              |
        v                                              v
sync-scheduler ──> getConnectorType(cfg.type) ──> KubernetesType
                        |  build(cfg, ctx) -> BuildResult { connector, sdkConfig }
                        |  probe(body, ctx)  -> ProbeResult
                        v
              ConnectorHarness.runSync('full')
                 authenticate -> discover -> fetch(pages) -> normalize -> publish
                        |
                        v
               event-bus (BullMQ)  ── envelopes kind:'entities'
                        |
                        v
                 core-writer  ── nodes + edges (existing path)
                        ^
                        |  envelope kind:'sync.completed' { startedAt }
sync-scheduler ─────────┘  (emitted only when status === 'success' && mode === 'full' && type.sweepsAbsent)
                 core-writer sweep: _absent_since = now on unseen nodes of that instance
```

Everything above the harness is new-but-generic (the factory); everything the harness
calls is the connector package; the two envelope kinds are the only bus change.

## Connector package — `packages/connectors/kubernetes`

```
src/
  index.ts              exports KubernetesConnector, types, buildKubeClients
  connector.ts          KubernetesConnector implements ShipItConnector
  auth.ts               access modes -> KubeConfig; validation; client factory seam
  fetchers/
    cluster.ts          version + nodes -> provider/region/version
    namespaces.ts       paged list, include/exclude globs
    workloads.ts        Deployment/StatefulSet/DaemonSet/CronJob per namespace + pod summary
  normalizers/
    cluster.ts          Cluster node
    namespace.ts        Namespace node, PART_OF, Environment node + derivation
    workload.ts         Deployment, BuildArtifact, LogicalService, all edges
    linking.ts          tiered repository resolution (pure)
    environment.ts      derivation rules (pure)
    identity.ts         canonical ids + linking keys (pure)
```

### Access modes (`auth.ts`)

`ConnectorConfig.credentials` carries one of:

| mode         | credentials                          | how the `KubeConfig` is built                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `in-cluster` | none                                 | `loadFromCluster()`; fails `IN_CLUSTER_UNAVAILABLE` when the SA token file is absent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `kubeconfig` | `kubeconfig` (YAML text)             | Parsed by the connector itself with the `yaml` package (`{ logLevel: 'silent' }`), structure-validated, field-allowlisted, and loaded via `KubeConfig.loadFromOptions` — `loadFromString()` is never called on user-supplied text (its `findToken()` reads file-referencing keys off the filesystem during parsing, before any validation runs). Must have exactly one context (or a configured `context`); the user entry must carry `token`, `client-certificate-data`/`client-key-data` or basic auth. Rejected before anything loads: any user carrying `token-file`, `client-certificate`, `client-key` (→ `KUBECONFIG_INVALID`) or `exec`/`auth-provider` (→ `UNSUPPORTED_AUTH_PLUGIN`); any cluster carrying `certificate-authority` (file) or `insecure-skip-tls-verify`; forbidden keys are checked in EVERY entry, not only the selected context. YAML parse errors report only the error name and line, never the message or a snippet. |
| `token`      | `server`, `caData` (base64), `token` | assembled into a single-context `KubeConfig`; `insecureSkipTlsVerify` is **not** offered                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

A `ClientFactory` (`KubeConfig -> { core, apps, batch, version }`) is injected through the
constructor so tests substitute fakes without touching the network — the same pattern the
GitHub tests use by stubbing `octokit`.

### Fetch contract

`discover()` returns entity types `['Cluster', 'Namespace', 'Workload']` in that order so
namespaces (and their environments) are published before the workloads that reference them.
Ordering is best-effort: the writer batches asynchronously, and an edge whose target has not
landed yet is dropped and re-emitted on the next run.

| entity type | API calls                                                                                                                                                                                                                                                                                                                         | cursor                               |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `Cluster`   | `GET /version`; `list nodes` (bounded probe of the first node only, `limit 1`; `continue` intentionally not threaded)                                                                                                                                                                                                             | none                                 |
| `Namespace` | `list namespaces` `limit 500` + `continue`                                                                                                                                                                                                                                                                                        | the `continue` token                 |
| `Workload`  | per included namespace: `list deployments/statefulsets/daemonsets/cronjobs` (`limit 500`, `continue`) and **one** `list pods` + **one** `list replicasets` per namespace, matched to workloads in memory by owner-reference chain (`Pod -> ReplicaSet -> Deployment`, `Pod -> StatefulSet`, `Pod -> DaemonSet`, `Job -> CronJob`) | `<namespaceIndex>~<kind>~<continue>` |

Namespace filtering: `scope.namespaces.include` globs (default `['*']`) minus
`scope.namespaces.exclude` (default `['kube-system', 'kube-public', 'kube-node-lease']`).
`scope.kinds` defaults to all four workload kinds.

Pod rollups: `readyPods` and `restarts` sum over every pod owned by a workload (all
revisions mid-rollout). Image digests are attributed only to pods owned by the
ReplicaSet(s) at the Deployment's highest numeric `deployment.kubernetes.io/revision`
annotation (all owned ReplicaSets when none carry the annotation); a container with more
than one distinct digest among those pods is ambiguous and the digest is omitted entirely.
A single `rollupsForbidden` flag: the first 403 on `pods` or `replicasets` disables
pod/ReplicaSet rollups for the rest of the run and emits one warning — `FORBIDDEN:pods —
pod/replicaset rollups (ready counts, restarts, digests) disabled; grant list on pods and
replicasets to the ShipIt ServiceAccount` — workloads still sync without those fields. A
403 on a workload kind itself is reported per kind as `FORBIDDEN:<kind>`.

`normalize(raw)` type-sniffs like the GitHub connector: a record with `apiVersion` +
`kind` dispatches on `kind`; the cluster summary and the per-workload pod summary are
wrapped records (`{ __shipit: 'cluster' | 'workload', ... }`) so the sniffing is
unambiguous.

`refetchWorkload(namespace, kind, name)` fetches one workload plus its pods and runs the
same `normalize()`; errors are classified via `classifyError`, and a workload that no
longer exists returns an empty entity (`{ nodes: [], edges: [] }`) rather than throwing —
the absence sweep handles deletions. Unused in v1, kept for the watch/webhook layer.

## Config schema (shared)

`connectorInstanceSchema` becomes `z.discriminatedUnion('type', [githubConnectorSchema,
kubernetesConnectorSchema])`. Committed example:

```yaml
connectors:
  instances:
    - id: k8s-demo
      type: kubernetes
      name: Demo cluster
      enabled: true
      schedule: '*/5 * * * *'
      cluster:
        name: shipit-demo # [a-z0-9-]{1,63}; the canonical-id scope
      access:
        mode: in-cluster # in-cluster | kubeconfig | token
        # kubeconfigPath: /data/keys/kubeconfig-k8s-demo.yaml   (mode: kubeconfig)
        # server: https://…  caDataPath: /data/keys/k8s-ca-k8s-demo.pem
        # tokenPath: /data/keys/k8s-token-k8s-demo               (mode: token)
        # context: prod                                          (optional)
      scope:
        namespaces: { include: ['*'], exclude: [kube-system, kube-public, kube-node-lease] }
        kinds: [Deployment, StatefulSet, DaemonSet, CronJob]
      mapping:
        service:
          nameFrom: [part-of, name, workload] # first present wins
          includeComponent: false # true -> "<name>/<component>"
        environment:
          label: environment # also tries `env`
          namespaceRules:
            - { pattern: '^(prod|production)', environment: production }
            - { pattern: '^(stag|staging)', environment: staging }
            - { pattern: '^(dev|development)', environment: development }
          default: null
        ownership:
          teamLabel: team
        repoLink:
          annotation: shipit.ai/github-repo
          githubOrg: null # null -> sole GitHub connector's org
          nameMatch: true
      runs: []
```

Zod refinements: exactly the fields for the chosen `access.mode` are present; every path
under `access` passes the existing `isAllowedKeyPath` allowlist; `namespaceRules[].pattern`
compiles; `cluster.name` matches the pattern above; `schedule` reuses the crontab refine.
`type KubernetesConnectorConfig = z.infer<…>` is exported beside `GitHubConnectorConfig`.

## Credentials

Secrets never enter YAML. The committed config references **paths** inside the existing key
directory (`SHIPIT_GITHUB_APP_KEY_DIR`, reused as-is; renaming it is a separate cleanup):

| file                   | written by                                        | consumed by               |
| ---------------------- | ------------------------------------------------- | ------------------------- |
| `kubeconfig-<id>.yaml` | `POST /api/connectors/kubernetes/credentials`     | scheduler via the factory |
| `k8s-token-<id>`       | same route (`mode: token`)                        | same                      |
| `k8s-ca-<id>.pem`      | same route (`mode: token`, when a CA is supplied) | same                      |

The durable connector blob (`ConnectorAppStore`, GSM `shipit-connector-apps`) gains
optional `kubeconfig?`, `k8sToken?` and `k8sCa?` strings on `BlobRecord`, written by
`sync()` from those files and materialized back by `loadAndMaterialize()` — the same
lifecycle as the per-org PEM. Local/file deployments are already durable and unchanged.

The credentials route validates the payload **before** writing (kubeconfig parses, single
context, no `exec`/`auth-provider`; token is non-empty; CA is PEM), writes with mode `0600`,
and returns the path(s). `POST /api/connectors/probe` accepts the same payload **inline**
and never persists it. Rate limits mirror the GitHub probe.

## Connector-type factory (api-server)

`packages/api-server/src/services/connector-types/`:

```ts
export interface ConnectorType<C extends ConnectorInstanceConfig = ConnectorInstanceConfig> {
  readonly type: C['type'];
  readonly pollMode: 'full' | 'incremental'; // mode the repeatable poll job enqueues
  readonly sweepsAbsent: boolean; // true only when a successful full run is exhaustive
  build(cfg: C, ctx: BuildContext): Promise<BuildResult>;
  probe?(body: unknown, ctx: BuildContext): Promise<ProbeResult>; // Kubernetes only; GitHub's probe stays in the route
}
export function getConnectorType(type: string): ConnectorType | undefined;
```

`BuildContext` also carries the live `globalApp` reference, `readPrivateKey`/`keyDir`,
`listConnectors()`, optional `lookupRepositoryNames`/`lookupTeamSlugs` (graph lookups the
Kubernetes linking tiers use — absent in unit tests / no Neo4j, in which case the tiers
simply do not match) and an optional structured `logger` (`warn`), used when a lookup
throws so `build` continues with empty known-name lists instead of failing.

- `github.ts` moves the existing scheduler credential resolution (`resolveAppCredentials`,
  PEM read, `installationId`) into `build`; `pollMode: 'incremental'`, `sweepsAbsent: false`;
  its probe stays inline in the route.
- `kubernetes.ts` reads the credential files for the configured mode, resolves `githubOrg`
  (explicit, else the sole enabled GitHub connector's, else `null`) and the known-repository
  / known-team lists, and builds the connector with the real client factory; `pollMode:
'full'`, `sweepsAbsent: true`. `probe` builds a transient connector, calls `/version`,
  lists namespaces (first page), and attempts one `list` per configured kind in the first
  included namespace, returning `{ ok, cluster: { version }, namespaces: [...], kinds: {
<Kind>: 'ok' | 'forbidden' | 'error' | 'skipped', ... } }` so the wizard can warn before
  saving.
- There is no `validateCreate`/`summarize` seam: `routes/connectors.ts` `POST /` and
  `GET /` still branch inline on `body.type` and return the stored config as-is. A per-type
  adapter for create-time validation and list summaries was planned but not built in v1 —
  the factory covers `build`, `pollMode`, `sweepsAbsent` and `probe` only.
- Call sites that use the factory: `sync-scheduler.ts` (`pollMode` for the repeat job,
  `build` for credentials/connector construction, `sweepsAbsent` for the sweep gate) and
  `routes/connectors.ts` `POST /probe` (dispatches to `getConnectorType('kubernetes').probe`
  when `body.type === 'kubernetes'`, else the existing GitHub probe body).
  `connector-registry.ts` validates create/update bodies against the Zod
  `connectorInstanceSchema` discriminated union directly. `webhook-refetch-queue.ts` stays
  GitHub-specific.
- The BullMQ queue name stays `shipit-sync-github` so existing repeat jobs need no
  migration; a rename is a separate housekeeping change.
- `@kubernetes/client-node` is an api-server **dev** dependency only — the factory itself
  never imports it directly (it goes through `@shipit-ai/connector-kubernetes`), but the
  route/factory unit tests construct `ApiException` to simulate 401/403 responses.

## Data model

Conventions: `_source_system: 'kubernetes'`, `_source_org: 'kubernetes/<cluster>'`,
`_source_id` = linking key, `_event_version = deriveContentVersion(properties)` (polling
cannot deliver out of order; content hash means last-writer-wins, like Team/Person), claim
`source: 'kubernetes'`, claim `confidence: 0.85` (the registry value for kubernetes in
`source-reliability.ts`) unless stated. Every linking key is built with
`buildLinkingKey('kubernetes', …)` so it parses (`parseLinkingKey` requires `^[a-z0-9]+://`);
global nodes (`Environment`, `BuildArtifact`, `LogicalService`) still carry a cluster-prefixed
key — cross-cluster identity for them is the shared canonical id (primary-key match), not the
linking key.

| label            | canonical id                                                                                                                                | linking key                                                   | properties                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Cluster`        | `shipit://cluster/default/<cluster>`                                                                                                        | `k8s://<cluster>`                                             | `name`, `provider` (from node `spec.providerID` prefix: `gce`→gcp, `aws`, `azure`, else `unknown`), `region` (`topology.kubernetes.io/region` label, first node), `version` (`gitVersion`)                                                                                                                                                                                                |
| `Namespace`      | `shipit://namespace/default/<cluster>/<ns>`                                                                                                 | `k8s://<cluster>/<ns>`                                        | `name`, `cluster`, `labels` (`key=value` strings)                                                                                                                                                                                                                                                                                                                                         |
| `Environment`    | `shipit://environment/default/<env>` (**global**, shared across sources)                                                                    | `k8s://<cluster>/environment/<env>`                           | `name`, `type` (`development`/`staging`/`production` when the derived name is one of them, else omitted)                                                                                                                                                                                                                                                                                  |
| `Deployment`     | `shipit://deployment/default/<cluster>/<ns>/<kind>/<name>` (`kind` lower-case, so a Deployment and a StatefulSet named alike never collide) | `k8s://<cluster>/<ns>/<kind>/<name>`                          | `name`, `namespace`, `cluster`, `environment`, `kind`, `image` (first container), `images` (all), `replicas` (desired), `ready_replicas`, `status` (`Available` / `Progressing` / `Degraded` / `Suspended` for CronJobs / `Unknown`, from conditions), `created_at`, `restarts` (sum over matched pods), `labels` (only `app.kubernetes.io/*` and the configured environment/team labels) |
| `BuildArtifact`  | `shipit://build-artifact/default/<registry>/<repository>@<digest>` (falls back to `:<tag>` when the pod status carries no digest)           | `k8s://<cluster>/image/<registry>/<repository>@<digest\|tag>` | `name` (`<repository>`), `image_tag`, `sha` (digest), `registry`                                                                                                                                                                                                                                                                                                                          |
| `LogicalService` | `shipit://logical-service/default/<serviceName>` (**global**)                                                                               | `k8s://<cluster>/service/<serviceName>`                       | `name`; claims at **0.7** (the runtime is a weak authority on service identity)                                                                                                                                                                                                                                                                                                           |

Missing source data omits the property; nothing is fabricated.

Edges (`_source: 'kubernetes'`, `_ingested_at` = run time):

| type             | from → to                   | confidence                                                                           | properties                                                      |
| ---------------- | --------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `PART_OF`        | Namespace → Cluster         | 1.0                                                                                  |                                                                 |
| `RUNS_IN`        | Deployment → Namespace      | 1.0                                                                                  |                                                                 |
| `RUNS_IN_ENV`    | Deployment → Environment    | 0.95 from a label, 0.8 from a namespace rule, 0.6 from `mapping.environment.default` | `derived_from: label\|namespace-label\|namespace-rule\|default` |
| `RUNS_IMAGE`     | Deployment → BuildArtifact  | 1.0                                                                                  | `container`                                                     |
| `DEPLOYED_AS`    | LogicalService → Deployment | 1.0                                                                                  |                                                                 |
| `IMPLEMENTED_BY` | LogicalService → Repository | per linking tier                                                                     | `link_method`                                                   |
| `BUILT_FROM`     | BuildArtifact → Repository  | per linking tier                                                                     | `link_method`                                                   |
| `OWNS`           | Team → LogicalService       | 0.85                                                                                 | `derived_from: label\|namespace-label`                          |

The writer's `mergeEdge` does `MATCH` on both endpoints, so an edge whose Repository or Team
does not (yet) exist is silently dropped; the next run re-emits it. Edges to Repository and
Team target **predicted** ids built with the same helpers the GitHub connector uses
(`buildScopedCanonicalId('Repository', 'default', githubOrg, repoName)` and
`('Team', 'default', githubOrg, teamSlug)`).

Within one `normalize()` batch the connector keeps the highest-confidence edge per
`(type, from, to)`: several workloads of one service may link the same repository at
different tiers, and `mergeEdge` is last-writer-wins.

### Service identity

`serviceName` = first present of, per `mapping.service.nameFrom`: `app.kubernetes.io/part-of`,
`app.kubernetes.io/name`, the workload name. With `includeComponent: true` and an
`app.kubernetes.io/component` label, the name becomes `<name>/<component>`. Names are
lower-cased and trimmed to the `[a-z0-9._/-]` set for the id; the display `name` claim keeps
the original. The demo chart labels every workload `app.kubernetes.io/name: shipit-ai`, so
the default yields **one** `shipit-ai` service with five `DEPLOYED_AS` workload nodes: the four app
Deployments and the Redis StatefulSet, which carries the same chart-wide name label. Treating
Redis as part of the release's service is acceptable for v1; `includeComponent: true` splits
them into `shipit-ai/api-server`, `shipit-ai/redis`, and so on.

### Repository linking tiers (`linking.ts`)

Evaluated in order; the first hit wins and sets `link_method` and the edge confidence.

| tier | signal                                                                                                                              | confidence | `link_method` |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------- |
| 1    | `shipit.ai/github-repo: <org>/<repo>` annotation on the workload, else on its namespace                                             | 1.0        | `annotation`  |
| 2    | last path segment of the image repository (e.g. `…/shipit-ai/api-server` → `api-server`) equals a repository name, case-insensitive | 0.7        | `image-name`  |
| 3    | `app.kubernetes.io/name`, else `app.kubernetes.io/part-of`, equals a repository name, case-insensitive                              | 0.6        | `app-label`   |

Tiers 2 and 3 need `mapping.repoLink.githubOrg`; when `null`, the factory fills it from the
**sole** enabled GitHub connector's `org` and leaves the tiers disabled (with a run warning)
when there are zero or several. Tier-1 annotations whose value is not `<org>/<repo>` are
ignored and counted in the run's `errors`. The connector never queries Neo4j itself. At
build time the api-server passes it the repository names and team slugs GitHub already
synced for `githubOrg` (`knownRepositories` / `knownTeams`, source casing), so tiers 2–3
match case-insensitively and emit the predicted id with the repository's real casing. The
writer's MATCH-on-both-ends drop remains the backstop. The edge property `link_method` lets
the UI and `entity_detail` show _how_ a link was inferred.

### Environment derivation (`environment.ts`)

1. workload label `mapping.environment.label` (default `environment`, also `env`);
2. the same label on the namespace;
3. first matching `namespaceRules[].pattern` against the namespace name;
4. `mapping.environment.default`;
5. otherwise **no** Environment node and no `RUNS_IN_ENV` edge.

### Ownership

`mapping.ownership.teamLabel` (default `team`) on the workload, else on the namespace;
the value is slugified (`lower-case`, spaces→`-`) and targets the Team under `githubOrg`.

## Absence sweep

**Envelope.** `EventEnvelope` gains `kind?: 'entities' | 'sync.completed'` (absent means
`entities`, so existing producers and consumers are unaffected) and
`control?: { startedAt: string }`. `EventBusClient` gains
`publishControl(connectorId: string, control: { kind: 'sync.completed'; startedAt: string }):
Promise<void>`; the BullMQ producer uses job id `<connectorId>~sync-completed~<startedAtMs>`
(no `:` per the BullMQ 5 scar) so a retried run cannot double-sweep. Control envelopes are
not written to the optional replay stream.

**Emission.** `sync-scheduler.ts` publishes it after `harness.runSync` returns
`status === 'success'` for `mode === 'full'` — never for `partial` or `failed`, because a
partial run has not proven the missing nodes are gone. `startedAt` is the job's start
timestamp on the api-server clock, the same clock the normalizers use for `_last_synced`.
Both are `toISOString()` UTC strings, so the lexical `<` in the sweep is chronological.

**Writer.** `CoreWriter.processBatch` handles `event.kind === 'sync.completed'` before the
`payload.nodes` branch:

```cypher
MATCH (n)
WHERE n._source_connector_id = $connectorId
  AND n._last_synced < $startedAt
  AND n._absent_since IS NULL
SET n._absent_since = $now
RETURN count(n) AS marked
```

`writeNode`'s `SET` and `touchLastSynced` both add `n._absent_since = null`, so any node the
connector re-confirms — changed or unchanged — is present again. Idempotency entries are
kept for absent nodes, so a workload that reappears with identical content is a cheap
touch, not a rewrite. Edges of absent nodes are untouched; they hide with the node.

**Known limitation — shared global nodes.** `_source_connector_id` is overwritten by the most
recent writer. A `LogicalService` or `Environment` emitted by two clusters can be marked
absent by the instance that last wrote it if that cluster drops the app while the other
still runs it; the other instance's next successful run clears the marker. The window is
at most one sync interval and only affects nodes shared across instances.

**Read paths.** Default filters gain `AND n._absent_since IS NULL` beside the existing
internal-label exclusion in `neo4j-service.ts` (catalog list, overview, neighborhood, search)
and in the MCP tools' Cypher (`blast_radius`, `entity_detail` neighbors, `search_entities`,
`dependency_chain`, `find_owners`, `graph_stats`); each read accepts `include_absent`
(`includeAbsent` query param / MCP argument, default `false`). `entity_detail` on an absent
node by id still returns it, with `_absent_since` projected like `_last_synced_age_seconds`.
`graph_query` (raw Cypher) is unchanged.

The sweep is a per-connector-type opt-in (`ConnectorType.sweepsAbsent`): Kubernetes is
`true`, GitHub is `false`, because a GitHub full sync is not exhaustive (`scope.cappedAt`
defaults to 100 until acknowledged, plus repo include/exclude and `entities.*` toggles), so
unseen ≠ gone there, and a manual "Sync now" would otherwise stamp still-existing nodes
absent. The scheduler publishes `sync.completed` only when `status === 'success' && mode
=== 'full' && type.sweepsAbsent`. GitHub's opt-in is deferred until its full sync becomes
exhaustive (see Revisit Triggers in the design decision).

## Validation

- Create/update bodies go through the per-type Zod schema; the route no longer inlines field
  checks.
- `cluster.name` uniqueness is not enforced (two instances may legitimately point at the same
  cluster name with different scopes); instance `id` uniqueness is, as today.
- Annotation values must match `^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`.
- Every path in `access` must satisfy `isAllowedKeyPath` (CodeQL path-injection guard),
  reusing the two-branch structure the GitHub probe uses so the taint flow stays visible.

## Error handling

| code                      | where                      | meaning / UI copy                                                                                                        |
| ------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `IN_CLUSTER_UNAVAILABLE`  | authenticate, probe        | no ServiceAccount token mounted; choose kubeconfig or token                                                              |
| `UNSUPPORTED_AUTH_PLUGIN` | credentials route, probe   | kubeconfig uses `exec`/`auth-provider`; paste a ServiceAccount token instead                                             |
| `KUBECONFIG_INVALID`      | credentials route, probe   | does not parse, or zero/many contexts without `context`                                                                  |
| `API_UNREACHABLE`         | authenticate, probe, fetch | `ECONNREFUSED`/`ENOTFOUND`/timeout to the API server                                                                     |
| `TLS_ERROR`               | authenticate, probe        | certificate rejected; supply `caData`                                                                                    |
| `UNAUTHORIZED`            | fetch                      | 401 → harness `authFailed` → instance `degraded` (existing path)                                                         |
| `FORBIDDEN:<kind>`        | fetch                      | 403 listing one kind → that entity type errors, others continue, run is `partial`; probe reports the kind as `forbidden` |
| `NAMESPACE_SCOPE_EMPTY`   | fetch                      | include/exclude left no namespaces; run is `failed`                                                                      |
| `SCOPE_INVALID`           | authenticate               | `scope.cluster` or `scope.mapping` missing — a factory/build bug, not user-facing input                                  |

Every `authenticate()` failure is `<CODE>: message` (the `KubernetesError` constructor
prefixes the code). API errors: `classifyError` builds the message from `err.body.message`
(truncated to 200 chars) or `HTTP <status>` — never from `err.message`, which concatenates
the raw status line, response body and headers (which may carry `Set-Cookie` behind an auth
proxy).

Per-call timeout 30 s; `limit 500` with `continue` on every list except the Cluster node
probe (bounded to the first node, `limit 1`, `continue` not threaded); pods and
replicasets listed once per namespace. A run that raises outside a per-type fetch is
`failed` exactly as today.

## Safety

- Read-only: the connector never calls create/update/delete verbs; the ClusterRole grants
  only `get`, `list`, `watch`.
- Secrets never leave the key directory or the GSM blob; logs redact `credentials` (the
  harness never logs the config object; the factory logs only mode and path basename).
- `insecureSkipTlsVerify` is not accepted from user input.
- Kubernetes `Secret` objects are never listed.
- Property size: `labels` is capped to the `app.kubernetes.io/*` prefix plus the two
  configured labels; annotations are read but never stored.

## Testing

| layer                              | tests                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| connector unit                     | normalizers over fixture objects (each kind, namespace, node list) with exact node/edge snapshots; `linking.ts` table-driven over all three tiers and the disabled-org case; `environment.ts` and ownership rules; `auth.ts` mode detection and kubeconfig rejection cases                                                                                                |
| connector with fake clients        | injected `ClientFactory`: paging via `continue`, per-kind `403` → partial, empty scope → `NAMESPACE_SCOPE_EMPTY`, `refetchWorkload` produces the same output as a full pass                                                                                                                                                                                               |
| api-server unit                    | factory `build`/`probe` for both types (`pollMode`/`sweepsAbsent` registered per type, credential file reads, `resolveGithubOrg`, graph-lookup failures tolerated); credentials route path allowlist and rejection codes; scheduler emits `sync.completed` only on `success` + `full` + `sweepsAbsent`; registry create/update with the union                             |
| core-writer integration (CI Neo4j) | sweep marks only the instance's unseen nodes; `writeNode` clears; `touchLastSynced` clears; reads exclude absent by default and include on request                                                                                                                                                                                                                        |
| acceptance                         | a `reference-cluster.ts` fixture combined with the GitHub fixtures runs both normalizers through the writer and asserts the cross-source graph: Deployment → BuildArtifact → Repository, LogicalService → Repository, Team OWNS LogicalService, and `blast_radius` from the repository reaching the deployments — this seeds the currently unused `reference-graph` suite |
| manual                             | in-cluster on the demo after the infra brief; a local `kind` cluster via pasted kubeconfig and via token                                                                                                                                                                                                                                                                  |

The Neo4j-backed suites (`absence.integration`, `acceptance/cross-source.integration`) skip
without `NEO4J_TEST_URI` and are exercised by the CI `integration` job. That job runs
`vitest run .integration` straight after `pnpm install`, with no build step, so
`packages/core-writer/vitest.config.ts` aliases `@shipit-ai/*` workspace packages (including
the GitHub and Kubernetes connector packages) to their `src` entry points — the same fix
already applied in `packages/api-server/vitest.config.ts` and
`packages/event-bus/vitest.config.ts` — so the unbuilt integration job can collect the
acceptance test.

## Success criteria (v1 is done when)

1. On the demo cluster with `access.mode: in-cluster`, an instance created via the API
   syncs and yields 1 `Cluster`, the included namespaces, 5 `Deployment` nodes (four app
   Deployments plus the Redis StatefulSet), their `BuildArtifact`s and 1 `LogicalService`
   (`shipit-ai`) linked to the `ShipIt-AI` repository via the annotation
   (`link_method: annotation`).
2. A local `kind` cluster syncs via a pasted kubeconfig and via server+CA+token.
3. `blast_radius` from the `ShipIt-AI` repository with `direction: BOTH` and depth 2 returns
   the five workload nodes (`IMPLEMENTED_BY` points from the service _to_ the repository, so
   the tool's default `DOWNSTREAM` direction would not reach them).
4. Deleting a workload makes its node absent after the next successful run; it is hidden
   from catalog, graph and MCP defaults and visible with `include_absent`.
5. `probe` returns the structured codes above for unreachable, unauthorized, forbidden-kind
   and unsupported-auth inputs.
6. CI is green with the new unit, integration and acceptance tests, and no new
   `pnpm.overrides`.

## Infra brief (cross-repo, `shipit-ai-infra`)

- `ClusterRole shipit-reader`: `get`, `list`, `watch` on `namespaces`, `nodes`, `pods`,
  `deployments`, `replicasets`, `statefulsets`, `daemonsets`, `jobs`, `cronjobs`;
  `ClusterRoleBinding` to the existing `api-server` ServiceAccount.
- Annotation `shipit.ai/github-repo: Ship-It-Ops/ShipIt-AI` on the four chart workloads.
- No new GSM container: uploaded credentials ride in the existing `shipit-connector-apps`
  blob.
- Docs: `docs/connectors.md` Kubernetes section replaces "Planned"; README connector table
  and roadmap updated.

## Spec 2 outline (Connector Hub UI, separate document)

- Picker: Kubernetes slot `available`.
- Wizard steps: **Access** (in-cluster card, shown as available when the probe reports the
  SA token; kubeconfig paste; server + CA + token), **Scope** (cluster name, namespace
  picker seeded from the probe, kinds, per-kind RBAC warnings), **Configure** (environment
  rules, team label, repo-link org and annotation hint, schedule field reuse), **Review**
  (dry-run summary via the SDK `dryRun`).
- Card and drawer adapters keyed by type via `summarize`; the GitHub-specific fields move
  behind the adapter.
- `lib/entity-types.ts` registers `Cluster`, `Namespace`, `BuildArtifact`, `Environment`
  (only `LogicalService`, `RuntimeService`, `Repository`, `Deployment`, `Pipeline`,
  `Monitor`, `Team`, `Person` exist today); the existing Kubernetes console deep link
  already consumes `Deployment.cluster/namespace/name`.
- Absent pill on catalog rows and entity pages, an "include absent" toggle wired to
  `includeAbsent`.
- Incident Mode's deployments panel populates with no change, via `DEPLOYED_AS`.

## Rollout

1. Backend PR(s) in dependency order: shared schema + envelope, factory refactor (GitHub
   behavior-preserving, green before Kubernetes lands), connector package, credentials
   route + probe, sweep + read filters, acceptance suite.
2. Infra PR: ClusterRole/binding + chart annotation; deploy.
3. Create the demo instance via the API; verify success criteria 1, 3, 4.
4. Spec 2 UI.

No instance exists until one is created, so shipping the backend is inert for existing
deployments; in v1 only Kubernetes instances sweep absence — GitHub does not, until its
full sync becomes exhaustive.

## Related

- `docs/adrs/ADR-003-phase1-mvp-scope.md` — Phase 1b deliverable.
- `docs/adrs/ADR-010-identity-resolution-phasing.md` — linking-key semantics that make the
  edges explicit rather than merges.
- `docs/adrs/ADR-011-service-model-simple-mode.md` — the four-node model this populates.
- `docs/agent/decisions/github-connector-architecture-v1.md` — the connector shape mirrored.
- `docs/agent/decisions/connector-apps-gsm-blob-durability.md` — credential durability reused.
- `docs/agent/decisions/webhook-receiver-design.md` — the refetch seam precedent.
- `docs/agent/open-questions/neo4j-no-indexes-declared.md` — revisit once this lands.
