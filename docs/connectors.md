# Connectors

Connectors pull data from external systems, normalize it into canonical entities, and publish it through the event bus for ingestion into the knowledge graph.

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

- Publishing normalized entities to the event bus in batches (default: 100)
- Sync state management via `SyncStateMachine`
- Error handling and state transitions

```
Sync States: IDLE → SYNCING → COMPLETING → IDLE
                                          → FAILED
                                          → DEGRADED
```

### Dry Run

Test a connector without writing to the graph:

```typescript
import { dryRun } from '@shipit-ai/connector-sdk';

const result = await dryRun(connector, config);
// Returns sample nodes (max 50), edges (max 20), and a summary
```

## GitHub Connector

The `@shipit-ai/connector-github` package pulls repositories, teams, people, pipelines, and CODEOWNERS from GitHub. As of v0.2 (P0), the connector is **multi-org**: one connector instance per GitHub org, all backed by a single shared GitHub App.

> **Full setup walkthrough lives in [docs/connectors/github-setup.md](./connectors/github-setup.md)** — App creation, permissions, env vars, rotation, troubleshooting. This section is the reference; the setup guide is the runbook.

### Supported Entity Types

| Entity     | Node Types Created | Relationships Created |
| ---------- | ------------------ | --------------------- |
| Repository | `Repository`       | —                     |
| Team       | `Team`, `Person`   | `MEMBER_OF`           |
| Pipeline   | `Pipeline`         | `BUILT_BY`            |
| Codeowners | —                  | `CODEOWNER_OF`        |

P1 adds first-class `WorkflowRun`, `Environment`, `Deployment`, plus branch-protection claims on `Repository`.

### Authentication

GitHub App only — PAT support was removed in v0.2. Setup has two paths:

- **Manifest flow** _(recommended)_: the Connector Hub wizard creates the App via GitHub's [App manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) endpoint. All permissions/events/webhook URL pre-filled. PEM is written to `~/.shipit/keys/github-app-<id>.pem` (override with `SHIPIT_GITHUB_APP_KEY_DIR`), App ID + path are persisted to `connectors.github.app.*`. Full walkthrough: [`github-setup.md` §0](./connectors/github-setup.md#0-manifest-flow-recommended).
- **Manual**: create the App yourself, set `GITHUB_APP_ID` + `GITHUB_APP_PRIVATE_KEY_PATH` env vars before starting the API server. Full walkthrough: [`github-setup.md` §2](./connectors/github-setup.md).

One App is configured globally via env vars and shared across all per-org connector instances:

```bash
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_PATH=/path/to/private-key.pem
GITHUB_WEBHOOK_SECRET=<32-byte-hex>            # P1 webhook verification
GITHUB_WEBHOOK_PUBLIC_URL=https://...          # P1 webhook delivery target
```

The per-org `installationId` lives in the connector instance (in `shipit.config.local.yaml`), not in env. Required App permissions: `Contents: Read`, `Metadata: Read`, `Actions: Read`, `Members: Read`.

### Per-org App override (optional)

By default every connector uses the global App configured via env vars. A connector can override that App on its own — useful for blast-radius isolation (dev App vs prod App) or for orgs that won't share an App:

```yaml
connectors:
  instances:
    - id: github-prod
      type: github
      org: prod-corp
      installationId: '55555'
      # Either or both of these fields can be present; the field that's
      # absent falls back to the global App's value.
      app:
        id: '654321'
        privateKeyPath: '/etc/shipit/keys/prod-app.pem'
```

The wizard collects this via the "Use a separate GitHub App for this org" advanced panel in step 1. The probe endpoint accepts the same override in its request body so the wizard can validate the credentials before persisting. See [`github-setup.md`](./connectors/github-setup.md) §6b for the full walkthrough.

### Data Normalization

The GitHub connector normalizes data with the following confidence levels:

- Repository properties: `0.9` confidence
- CODEOWNERS relationships: `0.95` confidence
- Team membership: `0.9` confidence

### CODEOWNERS Discovery

The connector searches for CODEOWNERS files in three locations:

1. `CODEOWNERS`
2. `.github/CODEOWNERS`
3. `docs/CODEOWNERS`

CODEOWNERS entries create `CODEOWNER_OF` edges from Person or Team nodes to Repository nodes.

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

Subsequent PATCH/DELETE require `If-Match: "<etag>"` to avoid clobbering concurrent edits — same ETag pattern as `/api/schema` ([ADR-016](./adrs/ADR-016-optimistic-concurrency-for-editable-config.md)).

### Triggering a Sync

```bash
# Full sync — re-fetch everything
curl -X POST http://localhost:3001/api/connectors/github-main/sync \
  -H 'Content-Type: application/json' \
  -d '{ "mode": "full" }'

# Incremental sync — only changes since last sync
curl -X POST http://localhost:3001/api/connectors/github-main/sync \
  -H 'Content-Type: application/json' \
  -d '{ "mode": "incremental" }'
```

## Kubernetes Connector

Polls a cluster read-only (every 5 minutes by default, full list each run) and emits
`Cluster`, `Namespace`, `Environment`, `Deployment` (one per Deployment / StatefulSet /
DaemonSet / CronJob), `BuildArtifact` and `LogicalService` nodes with `PART_OF`, `RUNS_IN`,
`RUNS_IN_ENV`, `RUNS_IMAGE`, `DEPLOYED_AS`, `IMPLEMENTED_BY`, `BUILT_FROM` and `OWNS` edges.
One connector instance per cluster. Design: `docs/superpowers/specs/2026-09-16-kubernetes-connector-design.md`.

### Access modes

| mode         | what you provide                                                                  | notes                                                                                                                                                                      |
| ------------ | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `in-cluster` | nothing                                                                           | uses the api-server pod's ServiceAccount; needs the read-only ClusterRole below                                                                                            |
| `kubeconfig` | a data-only kubeconfig (inline `*-data` fields), one context (or `context` named) | file references (`certificate-authority`, `client-certificate`, `client-key`, `token-file`), `exec` and `auth-provider` are rejected — mint a ServiceAccount token instead |
| `token`      | `server`, a ServiceAccount token, optional CA PEM                                 | TLS verification is always on                                                                                                                                              |

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
expanded and an unexpanded tilde is rejected by the path allowlist.

`POST /api/connectors/probe` with `{ "type": "kubernetes", "access": { ... } }` checks access before you
save: it returns the server version, the namespaces in scope and, per workload kind, `ok`, `forbidden`,
`error` or `skipped` (no namespace in scope).

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
    // Transform raw data into canonical nodes and edges
    const nodes: CanonicalNode[] = raw.map((item) => ({
      id: buildCanonicalId('logicalservice', 'default', item.name),
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
