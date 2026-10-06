# Connectors

Connectors pull data from external systems, normalize it into canonical entities, and publish it through the event bus for ingestion into the knowledge graph. Two ship today — **GitHub** and **Kubernetes** — and both are added from the web UI under **Configure → Connector Hub**. A second, separate contract lets a connector also produce **knowledge** (text documents for the knowledge layer) without touching the graph; the GitHub connector implements both.

## Connector SDK

The `@shipit-ai/connector-sdk` package provides the interface, harness, and utilities for building connectors.

### Connector Interface

Every connector implements the `ShipItConnector` interface:

```typescript
interface ShipItConnector {
  readonly manifest: ConnectorManifest;
  authenticate(config: ConnectorConfig): Promise<AuthResult>;
  discover(): Promise<DiscoveryResult>;
  fetch(entityType: string, cursor?: string): Promise<FetchResult>;
  normalize(raw: unknown[]): CanonicalEntity;
  sync(mode: 'full' | 'incremental'): Promise<SyncResult>;
  handleWebhook?(event: WebhookEvent): Promise<void>;
}
```

### Connector Manifest

```typescript
interface ConnectorManifest {
  name: string; // e.g., "github"
  version: string; // e.g., "1.0.0"
  schema_version: string; // Compatible schema version
  min_sdk_version: string; // Minimum SDK version
  supported_entity_types: string[]; // e.g., ["Repository", "Team", "Person"]
}
```

### Lifecycle

```
authenticate() → discover() → fetch(type, cursor?) → normalize(raw) → sync()
```

1. **authenticate** — Validate credentials and establish a connection
2. **discover** — Report available entity types and counts
3. **fetch** — Pull raw entities by type, with cursor-based pagination
4. **normalize** — Transform raw data into `CanonicalEntity` (nodes + edges + claims)
5. **sync** — Orchestrate a full or incremental sync

### ConnectorHarness

The `ConnectorHarness` wraps a connector and handles:

- Publishing each fetched page of normalized entities to the event bus, and a control envelope at the end of the run so the writer knows it completed
- Sync state management via `SyncStateMachine`
- Error handling and state transitions

```
Sync States: IDLE → SYNCING → COMPLETING → IDLE
                                          → FAILED
                                          → DEGRADED
```

Syncs run inside the api-server's `SyncScheduler`, on each instance's cron `schedule` and on demand (`POST /api/connectors/:id/sync`). Every node a connector emits is stamped by the writer with `_source_connector_id`, which powers the source facet in the catalog and the `sourceConnectorId` filters of `/api/graph`.

### Dry Run

Test a connector without writing to the graph:

```typescript
import { dryRun } from '@shipit-ai/connector-sdk';

const result = await dryRun(connector, config);
// Returns sample nodes (max 50), edges (max 20), and a summary
```

### Knowledge connectors

A connector that indexes text implements the SDK's second contract, `KnowledgeConnector` ([ADR-035](adrs/ADR-035-knowledge-layer-v1-foundations.md)): it lists **containers** (a repository, a space, a channel), and for the selected ones produces documents in `ChangeBatch`es that a `KnowledgeHarness` hands to a `KnowledgeSink` — the api-server's redacting sink into Postgres. Runs come in two modes, `poll` (what changed since the checkpoint) and `reconcile` (a full pass, nightly by default), under a time budget (`knowledge.sync.maxRunMinutes`) with checkpoints so a run that is cut off resumes where it stopped. The api-server's connector-type factory separates `build` (graph) from `buildKnowledge`, and a connector instance records each facet's runs separately (`lastRuns` and `lastKnowledgeRuns`, each with `facet: 'graph' | 'knowledge'`).

## GitHub Connector

The `@shipit-ai/connector-github` package pulls repositories, teams, people, pipelines and CODEOWNERS from GitHub, keeps them fresh through webhooks, and — when its knowledge facet is on — indexes pull requests, issues and Markdown docs. One connector instance per GitHub org.

> **Full setup walkthrough lives in [docs/connectors/github-setup.md](./connectors/github-setup.md)** — App creation, permissions, rotation, troubleshooting. This section is the reference; the setup guide is the runbook.

### Supported Entity Types

| Entity     | Node Types Created | Relationships Created                    |
| ---------- | ------------------ | ---------------------------------------- |
| Repository | `Repository`       | —                                        |
| Team       | `Team`, `Person`   | `MEMBER_OF`                              |
| Pipeline   | `Pipeline`         | `BUILT_BY`                               |
| Codeowners | —                  | `CODEOWNER_OF` (from `Person` or `Team`) |

Repository, Team and Pipeline IDs are scoped by org (`shipit://repository/default/<org>/<name>`, [ADR-021](adrs/ADR-021-org-scoped-canonical-ids-and-source-connector.md)); Person IDs are global and lower-cased, so a CODEOWNERS entry, a team membership and a sign-in all land on the same node. The `entities.{environment,deployment,branchProtection,workflowRun}` toggles exist in the instance config but nothing reads them yet: first-class Environments, Deployments, workflow runs and branch-protection claims are deferred with no target date.

### Authentication

A **GitHub App** per org is the default ([ADR-018](adrs/ADR-018-github-connector-v1.md)): the Connector Hub creates it through GitHub's [App manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) flow, with the permissions and events pre-filled, and GitHub keeps the App private to the org that owns it. The private key is written to `~/.shipit/keys/github-app-<id>.pem` (override the directory with `SHIPIT_GITHUB_APP_KEY_DIR`) with its webhook secret beside it, and the App ID and key path are stored on the connector instance. On a deployment that uses Google Secret Manager, per-org Apps and instances are mirrored into one `connector-apps` secret and restored at boot ([ADR-025](adrs/ADR-025-secrets-in-google-secret-manager.md)).

The alternative is **one shared App** installed in many orgs, which GitHub only allows for a public App. It is configured globally and inherited by every instance without an `app` override:

```bash
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=/path/to/private-key.pem
GITHUB_WEBHOOK_PUBLIC_URL=https://shipit.your-company.com/api/webhooks/github
GITHUB_WEBHOOK_SECRET=<32-byte-hex>   # or generate it from Admin → Settings → Webhooks
```

Required App permissions, all read: `contents`, `metadata`, `actions`, `members`, `deployments`, `administration`, `pull_requests`, `issues` (the last is what the knowledge facet's issues need, and an existing installation has to approve it when it is added).

### Per-org App override

Every instance may carry its own App; absent fields fall back to the global one:

```yaml
connectors:
  instances:
    - id: github-prod
      type: github
      org: prod-corp
      installationId: '55555'
      app:
        id: '654321'
        privateKeyPath: '/etc/shipit/keys/prod-app.pem'
```

The wizard's App step offers this as the **One App for this org** card (the recommended default); `POST /api/connectors/probe` accepts the same `app` override so credentials are validated before anything is persisted. `PATCH /api/connectors/:id` with `{ "app": null }` reverts an instance to the global App. See [`github-setup.md`](./connectors/github-setup.md) §6b.

### Schedule, rate limits and webhooks

Each instance polls on its cron `schedule` (default `*/30 * * * *`). `connectors.github.rateLimits.conditionalRequests` turns on Octokit's `If-None-Match` requests to stretch the 5,000/hour installation budget, and `maxConcurrentSyncs` (3) caps parallel runs.

Between polls, GitHub webhooks keep the graph fresh ([ADR-030](adrs/ADR-030-github-webhook-receiver.md)): `POST /api/webhooks/github` verifies the delivery's HMAC signature against the connector's App secret and queues a coalesced refetch — a `push` refetches the repository (including its CODEOWNERS), a `workflow_run` its workflows. The App created by the manifest flow already points at the receiver when `GITHUB_WEBHOOK_PUBLIC_URL` is set.

### Knowledge facet

Switching the facet on (`PATCH /api/connectors/:id` with a `knowledge` block; there is no UI for it yet) makes the connector list its repositories as containers:

```yaml
knowledge:
  enabled: true
  pullRequests: true
  issues: true
  docs: { enabled: true, paths: ['docs/**', '*.md'], maxFileBytes: 262144 }
  historyDays: 90
```

Then `GET /api/connectors/:id/containers` lists them, `POST …/containers/refresh` re-lists, and `PUT …/containers/:containerId` with `{ "selected": true }` selects one for indexing (a private repository also needs `"acknowledgeVisibility": true`, since its content becomes readable to every signed-in user). The next sync carries a `knowledge` facet run; the [knowledge-worker](architecture.md#knowledge-layer) embeds what it produced. The walkthrough is in [local-development.md §5](local-development.md#5-running-the-stack).

### Data Normalization

Claims leave the connector with a base confidence per kind — repository properties `0.9`, CODEOWNERS relationships `0.95`, team membership `0.9` — and get their effective, per-field confidence in the writer: time decay, corroboration from independent sources, conflict and ambiguity penalties, and a floor for values a person has verified ([ADR-029](adrs/ADR-029-per-field-confidence-and-verification.md)).

### CODEOWNERS Discovery

The connector searches for CODEOWNERS files in three locations:

1. `CODEOWNERS`
2. `.github/CODEOWNERS`
3. `docs/CODEOWNERS`

CODEOWNERS entries create `CODEOWNER_OF` edges from Person or Team nodes to Repository nodes, carrying the matched `pattern`.

### Registering via API

```bash
# Probe credentials first (optional, but the wizard does this)
curl -X POST http://localhost:3001/api/connectors/probe \
  -H 'Content-Type: application/json' \
  -d '{"installationId": "12345678"}'

# Create the connector
curl -X POST http://localhost:3001/api/connectors \
  -H 'Content-Type: application/json' \
  -d '{
    "id": "github-acme",
    "type": "github",
    "name": "Acme Corp",
    "installationId": "12345678",
    "org": "acme-corp",
    "enabled": true
  }'
```

Responses carry an `ETag`; send it back as `If-Match` on `PATCH`/`DELETE` to refuse a blind overwrite ([ADR-016](./adrs/ADR-016-optimistic-concurrency-for-editable-config.md)) — it is honoured when present and optional otherwise. Mutations need an administrator; see [api-reference.md](api-reference.md#connectors--apiconnectors) for every route and error code, including the probe's `APP_NOT_CONFIGURED`, `PRIVATE_KEY_PATH_NOT_ALLOWED`, `PRIVATE_KEY_UNREADABLE`, `BAD_PRIVATE_KEY`, `INSTALLATION_NOT_FOUND`, `INSUFFICIENT_PERMISSIONS` and `AUTH_FAILED`.

### Triggering a Sync

```bash
# Full sync — re-fetch everything
curl -X POST http://localhost:3001/api/connectors/github-acme/sync \
  -H 'Content-Type: application/json' \
  -d '{ "mode": "full" }'

# Incremental sync — only changes since last sync
curl -X POST http://localhost:3001/api/connectors/github-acme/sync \
  -H 'Content-Type: application/json' \
  -d '{ "mode": "incremental" }'
```

## Kubernetes Connector

Polls a cluster read-only (every 5 minutes by default, full list each run) and emits
`Cluster`, `Namespace`, `Environment`, `Deployment` (one per Deployment / StatefulSet /
DaemonSet / CronJob), `BuildArtifact` and `LogicalService` nodes with `PART_OF`, `RUNS_IN`,
`RUNS_IN_ENV`, `RUNS_IMAGE`, `DEPLOYED_AS`, `IMPLEMENTED_BY`, `BUILT_FROM` and `OWNS` edges.
One connector instance per cluster. The Connector Hub's Kubernetes wizard (Access · Connect ·
Configure · Review) collects the same things as the API calls below. Design:
`docs/superpowers/specs/2026-09-16-kubernetes-connector-design.md` and [ADR-033](adrs/ADR-033-kubernetes-connector-v1.md).

### Access modes

| mode         | what you provide                                                                  | notes                                                                                                                                                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `in-cluster` | nothing                                                                           | uses the api-server pod's ServiceAccount; needs the read-only ClusterRole below                                                                                                                                                                                        |
| `kubeconfig` | a data-only kubeconfig (inline `*-data` fields), one context (or `context` named) | file references (`certificate-authority`, `client-certificate`, `client-key`, `token-file`), `exec`, `auth-provider` and `proxy-url` are rejected — mint a ServiceAccount token instead, and expose an endpoint the ShipIt pod can reach directly rather than proxying |
| `token`      | `server`, a ServiceAccount token, optional CA PEM                                 | TLS verification is always on                                                                                                                                                                                                                                          |

Credentials never live in YAML. Store them first, then reference the returned paths:

```bash
curl -X POST localhost:3001/api/connectors/kubernetes/credentials \
  -H 'Content-Type: application/json' \
  -d '{ "connectorId": "k8s-demo", "mode": "token", "token": "<sa-token>", "caData": "-----BEGIN CERTIFICATE-----..." }'
# → { "mode": "token", "tokenPath": "/home/shipit/.shipit/keys/k8s-token-k8s-demo", "caDataPath": "/home/shipit/.shipit/keys/k8s-ca-k8s-demo.pem" }

curl -X POST localhost:3001/api/connectors -H 'Content-Type: application/json' -d '{
  "id": "k8s-demo", "type": "kubernetes", "name": "Demo cluster",
  "cluster": { "name": "shipit-demo" },
  "access": { "mode": "token", "server": "https://10.0.0.1:6443", "tokenPath": "/home/shipit/.shipit/keys/k8s-token-k8s-demo", "caDataPath": "/home/shipit/.shipit/keys/k8s-ca-k8s-demo.pem" }
}'
```

The returned paths are absolute, inside the key dir (`~/.shipit/keys` by default, override with
`SHIPIT_GITHUB_APP_KEY_DIR`) — paste them into the create body exactly as returned; `~` is not
expanded and an unexpanded tilde is rejected by the path allowlist (`CREDENTIAL_PATH_NOT_ALLOWED`;
an unreadable file is `CREDENTIALS_UNREADABLE`, a malformed kubeconfig `KUBECONFIG_INVALID`).

`POST /api/connectors/probe` with `{ "type": "kubernetes", "access": { ... } }` checks access before you
save: it returns the server version, the namespaces in scope and, per workload kind, `ok`, `forbidden`,
`error` or `skipped` (no namespace in scope).

The per-kind verdict is measured against **one** namespace — the first in scope, reported back as
`probedNamespace` — not the whole cluster. A namespace-scoped RoleBinding elsewhere in the cluster can
therefore still fail at sync time even when the probe is all-`ok`; `shipit-reader` below is a
ClusterRole precisely so that access is uniform.

### Read-only RBAC

```yaml
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: shipit-reader }
rules:
  - apiGroups: ['']
    resources: [namespaces, nodes, pods]
    verbs: [get, list, watch]
  - apiGroups: [apps]
    resources: [deployments, replicasets, statefulsets, daemonsets]
    verbs: [get, list, watch]
  - apiGroups: [batch]
    resources: [cronjobs]
    verbs: [get, list, watch]
```

`watch` is granted for the planned streaming mode (see Not in v1); v1 only ever lists.

Bind it to the ShipIt ServiceAccount (in-cluster) or to the ServiceAccount whose token you paste.
A workload kind the account may not list is reported as `FORBIDDEN:<kind>` on the run and the run is
marked partial; everything else still syncs. If `pods` or `replicasets` specifically cannot be listed,
ready counts, restarts and image digests are disabled for the rest of that run with a single
`FORBIDDEN:pods` warning; workloads still sync.

### Scope and mapping

```yaml
scope:
  namespaces: { include: ['*'], exclude: [kube-system, kube-public, kube-node-lease] }
  kinds: [Deployment, StatefulSet, DaemonSet, CronJob]
mapping:
  service: { nameFrom: [part-of, name, workload], includeComponent: false }
  environment:
    label: environment # also `env`; workload label, then namespace label
    namespaceRules: # then namespace-name regexes
      - { pattern: '^(prod|production)', environment: production }
      - { pattern: '^(stag|staging)', environment: staging }
      - { pattern: '^(dev|development)', environment: development }
    default: null # then this; otherwise no Environment
  ownership: { teamLabel: team } # slugified → GitHub team
  repoLink:
    annotation: shipit.ai/github-repo # tier 1: "<org>/<repo>", confidence 1.0
    githubOrg: null # tier 2/3 org; null = the sole GitHub connector's org
    nameMatch: true # tier 2: image name (0.7); tier 3: app.kubernetes.io/name (0.6)
```

Name tiers only link to repositories and teams GitHub has already synced. Put
`shipit.ai/github-repo: <org>/<repo>` on a workload (or its namespace) to pin the link.

Narrowing the scope — adding to `namespaces.exclude`, or removing a kind from `kinds` —
makes the next full run mark every workload in the newly-excluded set absent. That is by
design: the run no longer sees them, and the sweep cannot tell "out of scope" from "deleted".
Widen the scope again and the next run brings them back.

### Absence

After every successful run the connector's unseen nodes get `_absent_since` and disappear from
the catalog, graph and MCP tools. Pass `includeAbsent=true` (API) or `include_absent: true`
(MCP) to see them. Nothing is deleted. Only connector types that opt into the sweep run it —
Kubernetes does in v1; GitHub does not, because its full sync is capped and filtered, so an
unseen repository isn't proven gone.

**A `partial` run never sweeps.** Only warnings that mean _data was skipped_ make a run
partial, and today that is exactly the `FORBIDDEN:<kind>` warnings — a kind (or pods /
replicasets) the ServiceAccount may not list. Such a run has not seen the whole cluster, so
marking its unseen nodes absent would hide live workloads. The catch is that the denial is
usually permanent: every run reports it, every run is partial, and the sweep never runs at
all. If the connector sits at `degraded` with a `FORBIDDEN:` message, either grant the
missing verb (see [Read-only RBAC](#read-only-rbac)) or drop that kind from `scope.kinds`, so
runs go back to `success` and absence tracking resumes.

Link diagnostics — an unresolved `repoLink.githubOrg`, a `team` label that matches no synced
GitHub team — are **notes**, not warnings. They are recorded on the run and logged, they
never change its status, and they never block the sweep: they report enrichment that did not
happen, not cluster data that was missed.

**The sweep confirms before it marks.** core-writer first checks that at least one node of
this connector carries a `_last_synced` at or after the run's start. A successful full run
always re-confirms at least the Cluster node, so zero confirmations means the run's entities
never reached the graph (a write failed, or the queue was still draining an older run) — the
sweep marks nothing and logs instead. A write failure recorded in the same batch as the
control envelope also skips the sweep for that connector.

### Not in v1

Watch API streaming, Argo CD / Flux link signals, OCI image-label provenance, Services/Ingress
as nodes, Secrets/ConfigMaps/Events.

## Building a Custom Connector

### 1. Create the package

```bash
mkdir -p packages/connectors/my-source
cd packages/connectors/my-source
pnpm init
```

Add dependencies:

```json
{
  "dependencies": {
    "@shipit-ai/connector-sdk": "workspace:*",
    "@shipit-ai/shared": "workspace:*"
  }
}
```

### 2. Implement the interface

```typescript
import type {
  ShipItConnector,
  ConnectorManifest,
  ConnectorConfig,
  AuthResult,
  DiscoveryResult,
  FetchResult,
  SyncResult,
} from '@shipit-ai/connector-sdk';
import type { CanonicalEntity, CanonicalNode, PropertyClaim } from '@shipit-ai/shared';
import { buildCanonicalId } from '@shipit-ai/shared';

export class MySourceConnector implements ShipItConnector {
  readonly manifest: ConnectorManifest = {
    name: 'my-source',
    version: '1.0.0',
    schema_version: '1.0',
    min_sdk_version: '0.1.0',
    supported_entity_types: ['LogicalService'],
  };

  async authenticate(config: ConnectorConfig): Promise<AuthResult> {
    // Validate credentials
    return { success: true };
  }

  async discover(): Promise<DiscoveryResult> {
    // Report what entity types and counts are available
    return {
      entity_types: ['LogicalService'],
      total_entities: 42,
    };
  }

  async fetch(entityType: string, cursor?: string): Promise<FetchResult> {
    // Fetch raw data from your source
    return {
      entities: rawEntities,
      cursor: nextCursor,
      has_more: false,
    };
  }

  normalize(raw: unknown[]): CanonicalEntity {
    // Transform raw data into canonical nodes and edges. Pass the label as it
    // appears in the schema: the helper kebab-cases it in the id
    // (`shipit://logical-service/default/<name>`), which is what the
    // Kubernetes connector emits for the same service.
    const nodes: CanonicalNode[] = raw.map((item) => ({
      id: buildCanonicalId('LogicalService', 'default', item.name),
      label: 'LogicalService',
      properties: { name: item.name, owner: item.owner },
      _claims: [
        {
          property_key: 'owner',
          value: item.owner,
          source: 'my-source',
          source_id: `my-source://${item.id}`,
          ingested_at: new Date().toISOString(),
          confidence: 0.8,
          evidence: 'API response',
        },
      ],
      _source_system: 'my-source',
      _source_org: 'my-source/my-org',
      _source_id: `my-source://${item.id}`,
      _last_synced: new Date().toISOString(),
      _event_version: 1,
    }));

    return { nodes, edges: [] };
  }

  async sync(mode: 'full' | 'incremental'): Promise<SyncResult> {
    // Orchestrate the full sync process
    // The ConnectorHarness handles this for you in most cases
    return { status: 'success', entities_synced: 42, errors: [], duration_ms: 1234 };
  }
}
```

Entities owned by a multi-tenant source (an org, an account) should be scoped with `buildScopedCanonicalId(label, namespace, scope, name)` so two tenants' `platform` teams do not collide; a `Person` keyed by a globally unique login uses `buildPersonCanonicalId`. The writer adds `_source_connector_id` from the envelope — do not set it yourself. A base confidence of `0.7` is used for a source the reliability registry does not know; add your source to `SOURCE_RELIABILITY` in `packages/shared/src/config/source-reliability.ts` to give it its own.

### 3. Linking Keys

Register a linking key prefix for your source. Supported prefixes:

| Connector  | Prefix         |
| ---------- | -------------- |
| GitHub     | `github://`    |
| Kubernetes | `k8s://`       |
| Datadog    | `dd://`        |
| Backstage  | `backstage://` |
| Jira       | `jira://`      |
| Identity   | `idp://`       |

### 4. Test with dry-run

```typescript
import { dryRun } from '@shipit-ai/connector-sdk';
import { MySourceConnector } from './connector';

const connector = new MySourceConnector();
const result = await dryRun(connector, {
  id: 'my-source-test',
  type: 'my-source',
  credentials: { token: 'test' },
  scope: {},
});

console.log(result.summary);
console.log(`Nodes: ${result.nodes.length}, Edges: ${result.edges.length}`);
```

### 5. Register the type

The api-server creates connector instances through a per-type factory (`packages/api-server/src/services/connector-types/`): one entry builds the graph connector (`build`), an optional one builds its knowledge connector (`buildKnowledge`), and the same file declares how the type probes credentials and which warnings make a run partial. The Connector Hub's picker lists the types the factory knows.
