# Kubernetes Connector v1 (Spec 1: backend core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `kubernetes` connector instance, created through the existing registry and run by the existing BullMQ scheduler, reads a cluster read-only and populates `Cluster`, `Namespace`, `Environment`, `Deployment`, `BuildArtifact` and `LogicalService` nodes with the edges that tie running workloads to their GitHub repository and owning team; workloads that disappear are marked absent after the next successful sync and hidden from default reads.

**Architecture:** A new `@shipit-ai/connector-kubernetes` package implements `ShipItConnector` (access modes → paged fetchers → pure normalizers, all behind an injectable client factory). The api-server gains a connector-type factory (`services/connector-types/`) so the scheduler, registry and routes stop hard-coding GitHub. The event envelope gains a `sync.completed` control kind; the core-writer sweeps unseen nodes into `_absent_since`, and every read path (api-server + MCP) excludes absent nodes unless asked.

**Tech Stack:** TypeScript (ESM, NodeNext, `.js` import suffixes), Zod 4 (`.prefault({})` for nested defaults), Fastify 5, BullMQ 5, neo4j-driver 6, `@kubernetes/client-node` 1.4 (object-param API: `core.listNamespace({ limit, _continue })` resolves to the list body), Vitest 4, pnpm workspaces + Turborepo.

**Spec:** `docs/superpowers/specs/2026-09-16-kubernetes-connector-design.md` — read it first; every task below cites the section it implements.

## Global Constraints

- **GitHub behavior-preserving.** All existing GitHub connector, scheduler, registry and route tests stay green after the factory refactor (Task 10) _before_ any Kubernetes code touches the api-server (Task 11).
- **Read-only.** The connector only ever calls `list`/`get` verbs. Kubernetes `Secret` objects are never listed.
- **No secret values in YAML, logs, or HTTP responses.** Kubeconfig / token / CA are files in the key dir (`SHIPIT_GITHUB_APP_KEY_DIR`, default `~/.shipit/keys`) and ride in the `connector-apps` GSM blob.
- **Path allowlist.** Every user-supplied credential path passes the existing `isAllowedKeyPath` predicate and is consumed as `join(getAllowedKeyDir(), basename(path))` — the CodeQL js/path-injection sanitizer shape already used for PEMs.
- **Kubeconfig rules.** Exactly one context (or an explicit `context`), user auth must be `token`, client cert/key, or basic; `exec` / `auth-provider` → `UNSUPPORTED_AUTH_PLUGIN`; `insecure-skip-tls-verify: true` → `KUBECONFIG_INVALID`.
- **Paging + timeouts.** `limit: 500` + `_continue` on every list; one pod list and one ReplicaSet list per namespace; 30 s per-call timeout.
- **Claims.** kubernetes-sourced claim `confidence: 0.85`; `LogicalService` claims `0.7`; `_event_version = deriveContentVersion(properties)`; missing source data omits the property, never fabricates it.
- **BullMQ 5 forbids `:` in job ids.** Control job id is `<connectorId>~sync-completed~<startedAtMs>`.
- **Sweep gating.** Emitted only when `status === 'success'` **and** `mode === 'full'`. Kubernetes repeat jobs enqueue `mode: 'full'` (`pollMode`); GitHub repeat jobs stay `'incremental'`.
- **Clocks.** `_last_synced` and `startedAt` are both `toISOString()` UTC strings from the api-server clock, so the sweep's lexical `<` is chronological.
- **Deps.** No new `pnpm.overrides`. New workspace deps only: `@shipit-ai/connector-kubernetes` in api-server; dev-only `@shipit-ai/connector-github` + `@shipit-ai/connector-kubernetes` in core-writer (acceptance test).
- **Tests.** Run from the package dir with `npx vitest run <path>`; integration files are `*.integration.test.ts`, skip unless `NEO4J_TEST_URI` is set, and run serially in CI via `pnpm --filter <pkg> run test:integration` (shared-DB scar).
- **Commits.** Commit after every task. Plain messages, no `Co-Authored-By` trailer (user rule).

---

## File Structure

| Path                                                                                                                                                    | Responsibility                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/types/events.ts` (modify)                                                                                                          | `EventKind`, `SyncCompletedControl`, optional `kind`/`control` on the envelope, `publishControl` on the client type |
| `packages/shared/src/config/schema.ts` (modify)                                                                                                         | `kubernetesConnectorSchema`, union member, `KubernetesConnectorConfig` + sub-types, `KUBERNETES_WORKLOAD_KINDS`     |
| `packages/event-bus/src/bullmq/{producer,client}.ts` (modify)                                                                                           | `publishControl`                                                                                                    |
| `packages/core-writer/src/neo4j/queries.ts`, `node-writer.ts`, `writer.ts` (modify)                                                                     | `markAbsent`, clear-on-write/touch, control branch                                                                  |
| `packages/api-server/src/services/neo4j-service.ts`, `routes/graph.ts` (modify)                                                                         | `includeAbsent` on every read                                                                                       |
| `packages/mcp-server/src/cypher/generator.ts`, `tools/*.ts`, `tools/metadata.ts` (modify)                                                               | `include_absent` on the four traversal/search tools; stats always exclude absent                                    |
| `packages/connectors/kubernetes/src/types.ts`                                                                                                           | raw record + normalizer context types                                                                               |
| `packages/connectors/kubernetes/src/normalizers/identity.ts`                                                                                            | canonical ids, linking keys, image-ref parsing, slugs                                                               |
| `packages/connectors/kubernetes/src/normalizers/environment.ts`                                                                                         | environment derivation                                                                                              |
| `packages/connectors/kubernetes/src/normalizers/linking.ts`                                                                                             | tiered repository + team resolution                                                                                 |
| `packages/connectors/kubernetes/src/normalizers/{claims,cluster,namespace,workload}.ts`                                                                 | node/edge emission                                                                                                  |
| `packages/connectors/kubernetes/src/auth.ts`                                                                                                            | access modes → `KubeConfig`, kubeconfig validation, error classification, client factory seam                       |
| `packages/connectors/kubernetes/src/fetchers/{cluster,namespaces,workloads}.ts`                                                                         | paged list calls, pod summary                                                                                       |
| `packages/connectors/kubernetes/src/connector.ts`, `index.ts`                                                                                           | `KubernetesConnector`                                                                                               |
| `packages/api-server/src/services/connector-types/{index,github,kubernetes}.ts`                                                                         | connector-type factory                                                                                              |
| `packages/api-server/src/services/{sync-scheduler,connector-registry,connector-app-store,sync-runtime}.ts`, `routes/connectors.ts`, `index.ts` (modify) | generalization + Kubernetes wiring                                                                                  |
| `packages/core-writer/src/__tests__/acceptance/`                                                                                                        | cross-source acceptance fixture + test                                                                              |
| `docs/connectors.md`, `README.md`, `shipit.config.yaml`, `docs/agent/briefs/infra-k8s-reader-clusterrole.md`                                            | docs + infra brief                                                                                                  |

**Task order:** 1 → 2 → 3 → 4 → 5 (platform; independent of the connector) → 6 → 7 → 8 → 9 (connector package; only depends on Task 2 types) → 10 → 11 (api-server) → 12 → 13. Tasks 3–5 may run in parallel with 6–9.

---

### Task 1: Event envelope `kind` + `publishControl`

Implements spec §Absence sweep (envelope + bus).

**Files:**

- Modify: `packages/shared/src/types/events.ts`
- Modify: `packages/shared/src/index.ts:20` (the `./types/events.js` export line)
- Modify: `packages/event-bus/src/bullmq/producer.ts`
- Modify: `packages/event-bus/src/bullmq/client.ts`
- Test: `packages/event-bus/src/__tests__/event-bus.test.ts`

**Interfaces:**

- Produces: `type EventKind = 'entities' | 'sync.completed'`; `interface SyncCompletedControl { kind: 'sync.completed'; startedAt: string; mode: 'full' | 'incremental' }`; `EventEnvelope.kind?: EventKind`, `EventEnvelope.control?: SyncCompletedControl`; `EventBusClient.publishControl(connectorId: string, control: SyncCompletedControl): Promise<void>`; `EventBusProducer.publishControl(...)` with the same signature.
- Consumed by: Task 3 (writer branch on `event.kind`), Task 10 (scheduler emission).

- [ ] **Step 1: Write the failing tests**

Append to `packages/event-bus/src/__tests__/event-bus.test.ts` (after the existing `EventBusProducer` describe; `mockAddBulk`, `mockXadd`, `TEST_CONFIG`, `EventBusProducer`, `BullMQEventBusClient`, `EventEnvelope` are already in scope in that file):

```ts
describe('EventBusProducer.publishControl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('enqueues one sync.completed envelope with a colon-free, run-scoped job id and skips the stream', async () => {
    const producer = new EventBusProducer(TEST_CONFIG);
    const startedAt = '2026-09-16T10:00:00.000Z';

    await producer.publishControl('k8s-demo', { kind: 'sync.completed', startedAt, mode: 'full' });

    expect(mockAddBulk).toHaveBeenCalledTimes(1);
    const jobs = mockAddBulk.mock.calls[0][0] as Array<{
      name: string;
      data: EventEnvelope;
      opts: { jobId: string };
    }>;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe('event');
    expect(jobs[0].opts.jobId).toBe(`k8s-demo~sync-completed~${Date.parse(startedAt)}`);
    expect(jobs[0].opts.jobId).not.toContain(':');
    expect(jobs[0].data.kind).toBe('sync.completed');
    expect(jobs[0].data.connector_id).toBe('k8s-demo');
    expect(jobs[0].data.control).toEqual({ kind: 'sync.completed', startedAt, mode: 'full' });
    expect(jobs[0].data.payload).toEqual({ nodes: [], edges: [] });
    // TEST_CONFIG enables the replay stream; control envelopes must never land there.
    expect(mockXadd).not.toHaveBeenCalled();
  });

  it('rejects a startedAt that is not ISO-8601', async () => {
    const producer = new EventBusProducer(TEST_CONFIG);
    await expect(
      producer.publishControl('k8s-demo', {
        kind: 'sync.completed',
        startedAt: 'yesterday',
        mode: 'full',
      }),
    ).rejects.toThrow(/startedAt/);
    expect(mockAddBulk).not.toHaveBeenCalled();
  });

  it('BullMQEventBusClient.publishControl delegates to the producer', async () => {
    const client = new BullMQEventBusClient({ redisUrl: 'redis://localhost:6379' });
    await client.publishControl('gh-acme', {
      kind: 'sync.completed',
      startedAt: '2026-09-16T10:00:00.000Z',
      mode: 'full',
    });
    expect(mockAddBulk).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/event-bus && npx vitest run src/__tests__/event-bus.test.ts -t publishControl`
Expected: FAIL — `producer.publishControl is not a function`.

- [ ] **Step 3: Extend the shared envelope type**

Replace the body of `packages/shared/src/types/events.ts` with:

```ts
import type { CanonicalEntity } from './canonical.js';

/** Envelope kinds. An absent `kind` means `'entities'` (every pre-existing producer). */
export type EventKind = 'entities' | 'sync.completed';

/**
 * Control payload the scheduler publishes after a connector run finished with
 * `status: 'success'` in `mode: 'full'`. The core-writer marks every node stamped
 * with this connector id whose `_last_synced` predates `startedAt` as absent
 * (`_absent_since`). See docs/superpowers/specs/2026-09-16-kubernetes-connector-design.md.
 */
export interface SyncCompletedControl {
  kind: 'sync.completed';
  /** ISO-8601 UTC start of the run, api-server clock — the same clock as `_last_synced`. */
  startedAt: string;
  mode: 'full' | 'incremental';
}

export interface EventEnvelope {
  id: string; // UUID
  timestamp: string; // ISO 8601
  connector_id: string;
  // {connector_id}~{entity_primary_key}~{event_version} — `:` is forbidden
  // by BullMQ 5 in custom job IDs, so the key uses `~` as both separator and
  // colon replacement. Opaque downstream; only used for dedup + replay.
  idempotency_key: string;
  payload: CanonicalEntity;
  /** Absent ⇒ `'entities'`. Control envelopes carry an empty payload. */
  kind?: EventKind;
  control?: SyncCompletedControl;
}

export interface EventHandler {
  (event: EventEnvelope): Promise<void>;
}

export interface EventBusClient {
  publish(events: CanonicalEntity[], connectorId: string): Promise<void>;
  /** Publish a control envelope (no entities). See `SyncCompletedControl`. */
  publishControl(connectorId: string, control: SyncCompletedControl): Promise<void>;
  subscribe(handler: EventHandler): Promise<void>;
  replay(fromTimestamp: string): Promise<void>;
  close(): Promise<void>;
}
```

In `packages/shared/src/index.ts` change line 20 to:

```ts
export type {
  EventEnvelope,
  EventHandler,
  EventBusClient,
  EventKind,
  SyncCompletedControl,
} from './types/events.js';
```

- [ ] **Step 4: Implement `publishControl` in the producer and client**

In `packages/event-bus/src/bullmq/producer.ts` extend the shared import and add the method after `publish()`:

```ts
import type {
  CanonicalEdge,
  CanonicalEntity,
  CanonicalNode,
  EventEnvelope,
  SyncCompletedControl,
} from '@shipit-ai/shared';
```

```ts
  /**
   * Publish a control envelope (no entities). `sync.completed` tells the
   * core-writer that a full run for `connectorId` finished successfully, so it
   * can mark every node of that instance not re-confirmed since `startedAt` as
   * absent. The job id is run-scoped (and colon-free, BullMQ 5) so a retried
   * run cannot enqueue a second sweep for the same start time. Deliberately
   * NOT written to the replay stream — it is not entity history.
   */
  async publishControl(connectorId: string, control: SyncCompletedControl): Promise<void> {
    const startedAtMs = Date.parse(control.startedAt);
    if (!Number.isFinite(startedAtMs)) {
      throw new Error(
        `publishControl: startedAt must be an ISO-8601 timestamp, got "${control.startedAt}"`,
      );
    }
    const envelope: EventEnvelope = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      connector_id: connectorId,
      idempotency_key: `${connectorId}~sync-completed~${startedAtMs}`.replace(/:/g, '~'),
      payload: { nodes: [], edges: [] },
      kind: 'sync.completed',
      control,
    };
    await this.queue.addBulk([
      { name: 'event', data: envelope, opts: { jobId: envelope.idempotency_key } },
    ]);
  }
```

In `packages/event-bus/src/bullmq/client.ts`:

```ts
import type {
  CanonicalEntity,
  EventBusClient,
  EventHandler,
  SyncCompletedControl,
} from '@shipit-ai/shared';
```

```ts
  async publishControl(connectorId: string, control: SyncCompletedControl): Promise<void> {
    await this.producer.publishControl(connectorId, control);
  }
```

- [ ] **Step 5: Run the tests**

Run: `cd packages/event-bus && npx vitest run src/__tests__/event-bus.test.ts`
Expected: PASS (all, including the three new ones).

- [ ] **Step 6: Fix every fake `EventBusClient` the new required method breaks**

Run: `pnpm turbo typecheck --force`
For each error of the form `Property 'publishControl' is missing in type ...` (expected in `packages/api-server/src/__tests__/services/sync-runtime.test.ts`, `webhook-refetch-queue.test.ts`, and any test that builds an `EventBusClient` object literal), add to that fake:

```ts
publishControl: vi.fn().mockResolvedValue(undefined),
```

Re-run until typecheck is clean: `pnpm turbo typecheck --force` → 14/14 tasks succeed.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/types/events.ts packages/shared/src/index.ts packages/event-bus/src packages/api-server/src/__tests__
git commit -m "event-bus: sync.completed control envelopes via publishControl"
```

---

### Task 2: Kubernetes connector config schema

Implements spec §Config schema (shared).

**Files:**

- Modify: `packages/shared/src/config/schema.ts` (insert after `githubConnectorSchema`, before `connectorInstanceSchema`)
- Modify: `packages/shared/src/config/index.ts:5-24`
- Modify: `packages/shared/src/index.ts:144-163` (the two `./config/index.js` export blocks)
- Test: `packages/shared/src/config/__tests__/kubernetes-connector-schema.test.ts` (create)

**Interfaces:**

- Produces: `KUBERNETES_WORKLOAD_KINDS` (readonly tuple), `type KubernetesWorkloadKind`, `type KubernetesConnectorConfig`, `type KubernetesMappingConfig = KubernetesConnectorConfig['mapping']`, `type KubernetesScopeConfig`, `type KubernetesAccessConfig`; `connectorInstanceSchema` accepts `type: 'kubernetes'`; `ConnectorInstanceConfig` becomes the two-member union.
- Consumed by: Tasks 6–11.

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/config/__tests__/kubernetes-connector-schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { connectorInstanceSchema, KUBERNETES_WORKLOAD_KINDS } from '../schema.js';

const minimal = {
  id: 'k8s-demo',
  type: 'kubernetes',
  name: 'Demo cluster',
  cluster: { name: 'shipit-demo' },
  access: { mode: 'in-cluster' },
};

describe('kubernetesConnectorSchema', () => {
  it('parses a minimal in-cluster instance and fills every default', () => {
    const parsed = connectorInstanceSchema.parse(minimal);
    if (parsed.type !== 'kubernetes') throw new Error('expected a kubernetes instance');
    expect(parsed.enabled).toBe(true);
    expect(parsed.schedule).toBe('*/5 * * * *');
    expect(parsed.scope.namespaces).toEqual({
      include: ['*'],
      exclude: ['kube-system', 'kube-public', 'kube-node-lease'],
    });
    expect(parsed.scope.kinds).toEqual([...KUBERNETES_WORKLOAD_KINDS]);
    expect(parsed.mapping.service).toEqual({
      nameFrom: ['part-of', 'name', 'workload'],
      includeComponent: false,
    });
    expect(parsed.mapping.environment.label).toBe('environment');
    expect(parsed.mapping.environment.namespaceRules).toHaveLength(3);
    expect(parsed.mapping.environment.default).toBeNull();
    expect(parsed.mapping.ownership).toEqual({ teamLabel: 'team' });
    expect(parsed.mapping.repoLink).toEqual({
      annotation: 'shipit.ai/github-repo',
      githubOrg: null,
      nameMatch: true,
    });
    expect(parsed.lastRuns).toEqual([]);
  });

  it('rejects a cluster name that is not DNS-label style', () => {
    expect(() =>
      connectorInstanceSchema.parse({ ...minimal, cluster: { name: 'Prod_Cluster' } }),
    ).toThrow(/cluster\.name/);
  });

  it('requires kubeconfigPath for mode kubeconfig and an https server for mode token', () => {
    expect(() =>
      connectorInstanceSchema.parse({ ...minimal, access: { mode: 'kubeconfig' } }),
    ).toThrow();
    expect(() =>
      connectorInstanceSchema.parse({
        ...minimal,
        access: { mode: 'token', server: 'http://10.0.0.1', tokenPath: '/data/keys/k8s-token-x' },
      }),
    ).toThrow(/https/);
    const ok = connectorInstanceSchema.parse({
      ...minimal,
      access: {
        mode: 'token',
        server: 'https://10.0.0.1:6443',
        tokenPath: '/data/keys/k8s-token-x',
      },
    });
    if (ok.type !== 'kubernetes') throw new Error('expected a kubernetes instance');
    expect(ok.access.mode).toBe('token');
  });

  it('rejects an invalid namespaceRules regex and an unknown workload kind', () => {
    expect(() =>
      connectorInstanceSchema.parse({
        ...minimal,
        mapping: { environment: { namespaceRules: [{ pattern: '(', environment: 'x' }] } },
      }),
    ).toThrow(/regular expression/);
    expect(() =>
      connectorInstanceSchema.parse({ ...minimal, scope: { kinds: ['Pod'] } }),
    ).toThrow();
  });

  it('keeps parsing github instances through the union', () => {
    const gh = connectorInstanceSchema.parse({
      id: 'gh',
      type: 'github',
      name: 'GH',
      installationId: '1',
      org: 'acme',
    });
    expect(gh.type).toBe('github');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/shared && npx vitest run src/config/__tests__/kubernetes-connector-schema.test.ts`
Expected: FAIL — `KUBERNETES_WORKLOAD_KINDS` is not exported / union rejects `type: 'kubernetes'`.

- [ ] **Step 3: Add the schema**

In `packages/shared/src/config/schema.ts`, insert directly after `export type LastRun = z.infer<typeof lastRunSchema>;` and before the `// Discriminated union` comment:

```ts
// ── Kubernetes connector instance ─────────────────────────────────────────
// One instance per cluster: `cluster.name` scopes every canonical id the
// connector emits, the way a GitHub org scopes repository ids. Credentials
// NEVER live here — `access` references FILES inside the key dir (written by
// POST /api/connectors/kubernetes/credentials, mirrored into the connector-apps
// GSM blob). Design: docs/superpowers/specs/2026-09-16-kubernetes-connector-design.md

export const KUBERNETES_WORKLOAD_KINDS = [
  'Deployment',
  'StatefulSet',
  'DaemonSet',
  'CronJob',
] as const;
export type KubernetesWorkloadKind = (typeof KUBERNETES_WORKLOAD_KINDS)[number];

const K8S_CLUSTER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const HTTPS_URL = /^https:\/\/\S+$/;

function isValidRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

const kubernetesAccessSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('in-cluster') }),
  z.object({
    mode: z.literal('kubeconfig'),
    kubeconfigPath: z.string().min(1),
    context: z.string().min(1).optional(),
  }),
  z.object({
    mode: z.literal('token'),
    server: z.string().regex(HTTPS_URL, 'server must be an https:// URL'),
    tokenPath: z.string().min(1),
    caDataPath: z.string().min(1).optional(),
  }),
]);

const kubernetesScopeSchema = z
  .object({
    namespaces: z
      .object({
        include: z.array(z.string().min(1)).default(['*']),
        exclude: z
          .array(z.string().min(1))
          .default(['kube-system', 'kube-public', 'kube-node-lease']),
      })
      .prefault({}),
    kinds: z
      .array(z.enum(KUBERNETES_WORKLOAD_KINDS))
      .min(1)
      .default([...KUBERNETES_WORKLOAD_KINDS]),
  })
  .prefault({});

const kubernetesMappingSchema = z
  .object({
    service: z
      .object({
        nameFrom: z
          .array(z.enum(['part-of', 'name', 'workload']))
          .min(1)
          .default(['part-of', 'name', 'workload']),
        includeComponent: z.boolean().default(false),
      })
      .prefault({}),
    environment: z
      .object({
        label: z.string().min(1).default('environment'),
        namespaceRules: z
          .array(
            z.object({
              pattern: z
                .string()
                .min(1)
                .refine(isValidRegex, { message: 'pattern must be a valid regular expression' }),
              environment: z.string().min(1),
            }),
          )
          .default([
            { pattern: '^(prod|production)', environment: 'production' },
            { pattern: '^(stag|staging)', environment: 'staging' },
            { pattern: '^(dev|development)', environment: 'development' },
          ]),
        default: z.string().min(1).nullable().default(null),
      })
      .prefault({}),
    ownership: z.object({ teamLabel: z.string().min(1).default('team') }).prefault({}),
    repoLink: z
      .object({
        annotation: z.string().min(1).default('shipit.ai/github-repo'),
        githubOrg: z.string().min(1).nullable().default(null),
        nameMatch: z.boolean().default(true),
      })
      .prefault({}),
  })
  .prefault({});

const kubernetesConnectorSchema = z.object({
  id: z.string().min(1),
  type: z.literal('kubernetes'),
  enabled: z.boolean().default(true),
  name: z.string().min(1),
  schedule: z.string().default('*/5 * * * *').refine(isCrontabShape, {
    message: 'Invalid cron schedule — expected a 5-field crontab string, e.g. "*/5 * * * *".',
  }),
  cluster: z.object({
    name: z
      .string()
      .regex(
        K8S_CLUSTER_NAME,
        'cluster.name must be lowercase DNS-label style ([a-z0-9-], max 63 chars)',
      ),
  }),
  access: kubernetesAccessSchema,
  scope: kubernetesScopeSchema,
  mapping: kubernetesMappingSchema,
  lastRuns: z.array(lastRunSchema).default([]),
});

export type KubernetesConnectorConfig = z.infer<typeof kubernetesConnectorSchema>;
export type KubernetesMappingConfig = KubernetesConnectorConfig['mapping'];
export type KubernetesScopeConfig = KubernetesConnectorConfig['scope'];
export type KubernetesAccessConfig = KubernetesConnectorConfig['access'];
```

Then change the union line to:

```ts
export const connectorInstanceSchema = z.discriminatedUnion('type', [
  githubConnectorSchema,
  kubernetesConnectorSchema,
]);
```

- [ ] **Step 4: Export from both barrels**

`packages/shared/src/config/index.ts` — add `KUBERNETES_WORKLOAD_KINDS` to the value export list from `./schema.js` and add these to the type export list:

```ts
  KubernetesConnectorConfig,
  KubernetesMappingConfig,
  KubernetesScopeConfig,
  KubernetesAccessConfig,
  KubernetesWorkloadKind,
```

`packages/shared/src/index.ts` — same two additions in the corresponding `./config/index.js` value and type export blocks (around lines 144–163).

- [ ] **Step 5: Run the test + typecheck**

Run: `cd packages/shared && npx vitest run src/config/__tests__/kubernetes-connector-schema.test.ts && npx tsc --noEmit`
Expected: PASS, no type errors.

Then: `pnpm turbo typecheck --force`. The union change will surface errors in `packages/api-server` where `ConnectorInstanceConfig` was assumed to be GitHub-only (e.g. `c.installationId` in `routes/connectors.ts:213`, `connector as GitHubConnectorConfig` casts). Do **not** fix them by casting; they are resolved structurally in Task 10. For now make the build green with the narrowest change: guard `c.installationId` reads with `c.type === 'github' &&` and leave the explicit `as GitHubConnectorConfig` casts (they still compile). Record every place you touched in the commit message.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/config packages/shared/src/index.ts packages/api-server/src
git commit -m "shared: kubernetes connector config schema (union member, defaults, validation)"
```

---

### Task 3: Core-writer absence sweep (`_absent_since`)

Implements spec §Absence sweep (writer).

**Files:**

- Modify: `packages/core-writer/src/neo4j/queries.ts` (`mergeNode` SET block at ~line 86, `touchLastSynced` at ~line 138, new `markAbsent`)
- Modify: `packages/core-writer/src/neo4j/node-writer.ts`
- Modify: `packages/core-writer/src/writer.ts` (`WriteResult`, `NodeWriter`, `processBatch`)
- Test: `packages/core-writer/src/__tests__/writer.test.ts` (extend)
- Test: `packages/core-writer/src/__tests__/absence.integration.test.ts` (create)

**Interfaces:**

- Consumes: `EventEnvelope.kind` / `control` (Task 1).
- Produces: `NodeWriter.markAbsent(connectorId: string, startedAt: string, now: string): Promise<number>`; `WriteResult.absentMarked: number`; `queries.markAbsent(tx, connectorId, startedAt, now)`.

- [ ] **Step 1: Write the failing unit tests**

In `packages/core-writer/src/__tests__/writer.test.ts` add `markAbsent` to both doubles:

```ts
// inside createMockNodeWriter():
    markAbsent: vi.fn().mockResolvedValue(2),
// inside createStatefulNodeWriter():
    markAbsent: vi.fn().mockResolvedValue(0),
```

Then append this describe block at the end of the file:

```ts
describe('CoreWriter — sync.completed control envelopes', () => {
  function controlEnvelope(
    connectorId: string,
    startedAt: string,
    mode: 'full' | 'incremental' = 'full',
  ): EventEnvelope {
    return {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      connector_id: connectorId,
      idempotency_key: `${connectorId}~sync-completed~${Date.parse(startedAt)}`,
      payload: { nodes: [], edges: [] },
      kind: 'sync.completed',
      control: { kind: 'sync.completed', startedAt, mode },
    };
  }

  it('calls markAbsent with the connector id and run start and reports the count', async () => {
    const nodeWriter = createMockNodeWriter();
    const writer = new CoreWriter(
      nodeWriter,
      new InMemoryLinkingKeyIndex(),
      new InMemoryIdempotencyChecker(),
      DEFAULT_CONFIG,
    );
    const result = await writer.processBatch([
      controlEnvelope('k8s-demo', '2026-09-16T10:00:00.000Z'),
    ]);
    expect(nodeWriter.markAbsent).toHaveBeenCalledTimes(1);
    expect(nodeWriter.markAbsent).toHaveBeenCalledWith(
      'k8s-demo',
      '2026-09-16T10:00:00.000Z',
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    );
    expect(result.absentMarked).toBe(2);
    expect(nodeWriter.writeNode).not.toHaveBeenCalled();
    expect(result.errors).toEqual([]);
  });

  it('ignores control envelopes for incremental runs', async () => {
    const nodeWriter = createMockNodeWriter();
    const writer = new CoreWriter(
      nodeWriter,
      new InMemoryLinkingKeyIndex(),
      new InMemoryIdempotencyChecker(),
      DEFAULT_CONFIG,
    );
    const result = await writer.processBatch([
      controlEnvelope('k8s-demo', '2026-09-16T10:00:00.000Z', 'incremental'),
    ]);
    expect(nodeWriter.markAbsent).not.toHaveBeenCalled();
    expect(result.absentMarked).toBe(0);
  });

  it('records a sweep failure as an error instead of throwing', async () => {
    const nodeWriter = createMockNodeWriter();
    (nodeWriter.markAbsent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('boom'));
    const writer = new CoreWriter(
      nodeWriter,
      new InMemoryLinkingKeyIndex(),
      new InMemoryIdempotencyChecker(),
      DEFAULT_CONFIG,
    );
    const result = await writer.processBatch([
      controlEnvelope('k8s-demo', '2026-09-16T10:00:00.000Z'),
    ]);
    expect(result.errors).toEqual(['Error sweeping absent nodes for k8s-demo: boom']);
    expect(result.absentMarked).toBe(0);
  });

  it('entity envelopes are unaffected and report absentMarked: 0', async () => {
    const nodeWriter = createMockNodeWriter();
    const writer = new CoreWriter(
      nodeWriter,
      new InMemoryLinkingKeyIndex(),
      new InMemoryIdempotencyChecker(),
      DEFAULT_CONFIG,
    );
    const result = await writer.processBatch([makeEnvelope([makeNode('repo-a')], [])]);
    expect(nodeWriter.markAbsent).not.toHaveBeenCalled();
    expect(result.absentMarked).toBe(0);
    expect(result.nodesWritten).toBe(1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/core-writer && npx vitest run src/__tests__/writer.test.ts -t "sync.completed"`
Expected: FAIL — `markAbsent` is not part of `NodeWriter` / `absentMarked` undefined.

- [ ] **Step 3: Queries — clear on write/touch, add the sweep**

In `packages/core-writer/src/neo4j/queries.ts`, inside `mergeNode`'s first `FOREACH` block, add `n._absent_since = null` as the last SET item:

```cypher
    FOREACH (_ IN CASE WHEN reject THEN [] ELSE [1] END |
      SET n += $properties,
          n._last_synced = $lastSynced,
          n._source_system = $sourceSystem,
          n._source_org = $sourceOrg,
          n._source_id = $sourceId,
          n._source_connector_id = $sourceConnectorId,
          n._event_version = $eventVersion,
          n._absent_since = null
    )
```

Replace `touchLastSynced` with (the connector re-confirmed the node exists, so absence is cleared even when the timestamp does not advance):

```ts
export async function touchLastSynced(
  tx: ManagedTransaction,
  nodeId: string,
  lastSynced: string,
): Promise<void> {
  await tx.run(
    `MATCH (n {id: $id})
     SET n._absent_since = null
     WITH n
     WHERE n._last_synced IS NULL OR n._last_synced < $lastSynced
     SET n._last_synced = $lastSynced`,
    { id: nodeId, lastSynced },
  );
}
```

Add after `touchLastSynced`:

```ts
/**
 * Absence sweep (sync.completed). Stamp `_absent_since` on every node this
 * connector instance wrote that it did NOT re-confirm during the run that
 * started at `startedAt`. Both timestamps are `toISOString()` UTC strings from
 * the api-server clock, so the lexical `<` is chronological. Nodes without a
 * `_last_synced` cannot be judged and are left alone. Returns the count marked.
 */
export async function markAbsent(
  tx: ManagedTransaction,
  connectorId: string,
  startedAt: string,
  now: string,
): Promise<number> {
  const result = await tx.run(
    `MATCH (n)
     WHERE n._source_connector_id = $connectorId
       AND n._last_synced IS NOT NULL
       AND n._last_synced < $startedAt
       AND n._absent_since IS NULL
     SET n._absent_since = $now
     RETURN count(n) AS marked`,
    { connectorId, startedAt, now },
  );
  const marked = result.records[0]?.get('marked') as
    { toNumber?: () => number } | number | undefined;
  return typeof marked === 'object' && marked?.toNumber ? marked.toNumber() : Number(marked ?? 0);
}
```

- [ ] **Step 4: NodeWriter interface + Neo4j implementation**

`packages/core-writer/src/writer.ts` — add to the `NodeWriter` interface after `touchLastSynced`:

```ts
  /**
   * Absence sweep for one connector instance: stamp `_absent_since = now` on
   * every node it wrote whose `_last_synced` predates `startedAt`. Returns the
   * number of nodes marked. See queries.markAbsent.
   */
  markAbsent(connectorId: string, startedAt: string, now: string): Promise<number>;
```

Add `absentMarked: number;` to `WriteResult` (after `claimsConflictSkipped`, with the doc comment `/** Nodes stamped absent by sync.completed control envelopes in this batch. */`).

`packages/core-writer/src/neo4j/node-writer.ts` — import `markAbsent` from `./queries.js` and add:

```ts
  async markAbsent(connectorId: string, startedAt: string, now: string): Promise<number> {
    return this.client.executeWrite(async (tx) => {
      return markAbsent(tx, connectorId, startedAt, now);
    }, this.database);
  }
```

- [ ] **Step 5: The control branch in `processBatch`**

In `packages/core-writer/src/writer.ts` `processBatch`, declare `let absentMarked = 0;` beside the other counters, and insert at the top of the `for (const event of batch)` loop, **before** `const { payload } = event;`:

```ts
// Control envelopes carry no entities. `sync.completed` (Kubernetes
// connector v1 absence sweep) marks the instance's unseen nodes absent;
// only a successful FULL run proves the missing nodes are gone.
if (event.kind === 'sync.completed') {
  const control = event.control;
  if (control && control.mode === 'full') {
    try {
      const marked = await this.nodeWriter.markAbsent(
        event.connector_id,
        control.startedAt,
        new Date().toISOString(),
      );
      absentMarked += marked;
      if (marked > 0) {
        console.warn(
          `[CoreWriter] sweep ${event.connector_id}: marked ${marked} node(s) absent (unseen since ${control.startedAt})`,
        );
      }
    } catch (err) {
      errors.push(
        `Error sweeping absent nodes for ${event.connector_id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  continue;
}
```

Add `absentMarked` to the returned object, and extend the batch-summary `console.warn` in the constructor to include it:

```ts
if (
  r.freshnessSkipped > 0 ||
  r.claimsConflictSkipped > 0 ||
  r.absentMarked > 0 ||
  r.errors.length > 0
) {
  console.warn(
    `[CoreWriter] batch: ${r.nodesWritten} written, ${r.duplicatesSkipped} dup, ${r.freshnessSkipped} freshness-skipped, ${r.claimsConflictSkipped} claims-conflict-skipped, ${r.absentMarked} marked-absent, ${r.errors.length} errors`,
  );
}
```

- [ ] **Step 6: Run unit tests**

Run: `cd packages/core-writer && npx vitest run`
Expected: PASS. (Any other test that builds a `NodeWriter` literal — grep `touchLastSynced: vi.fn` under `src/__tests__` — needs `markAbsent: vi.fn().mockResolvedValue(0)` added.)

- [ ] **Step 7: Write the integration test**

Create `packages/core-writer/src/__tests__/absence.integration.test.ts`:

```ts
/**
 * Neo4j-backed integration test for the absence sweep (Kubernetes connector v1):
 *   - markAbsent stamps `_absent_since` only on the connector's nodes whose
 *     `_last_synced` predates the run start
 *   - mergeNode (writeNode) clears `_absent_since`
 *   - touchLastSynced clears `_absent_since` even when the timestamp is not newer
 * Gated on NEO4J_TEST_URI; wipes the graph after each test. Runs serially in the
 * CI integration job (--no-file-parallelism; shared-DB scar).
 */
import { describe, it, expect, beforeAll, afterEach, afterAll } from 'vitest';
import type { CanonicalNode } from '@shipit-ai/shared';
import { Neo4jClient } from '../neo4j/client.js';
import { Neo4jNodeWriter } from '../neo4j/node-writer.js';

const URI = process.env.NEO4J_TEST_URI;
const USER = process.env.NEO4J_TEST_USER ?? 'neo4j';
const PASSWORD = process.env.NEO4J_TEST_PASSWORD ?? 'testpassword';
const DATABASE = process.env.NEO4J_TEST_DATABASE;

function workload(name: string, connectorId: string, lastSynced: string): CanonicalNode {
  return {
    id: `shipit://deployment/default/demo/shipit/deployment/${name}`,
    label: 'Deployment',
    properties: { name },
    _claims: [],
    _source_system: 'kubernetes',
    _source_org: 'kubernetes/demo',
    _source_id: `k8s://demo/shipit/deployment/${name}`,
    _source_connector_id: connectorId,
    _last_synced: lastSynced,
    // Content-hash style version: unorderable, so the freshness guard never rejects.
    _event_version: `ch_${name}`,
  };
}

describe.skipIf(!URI)('core-writer absence sweep — integration', () => {
  let client: Neo4jClient;
  let writer: Neo4jNodeWriter;

  beforeAll(async () => {
    client = new Neo4jClient();
    await client.connect({ uri: URI!, username: USER, password: PASSWORD, database: DATABASE });
    writer = new Neo4jNodeWriter(client, DATABASE);
  });

  afterEach(async () => {
    await client.executeWrite(async (tx) => tx.run('MATCH (n) DETACH DELETE n'), DATABASE);
  });

  afterAll(async () => {
    await client?.close();
  });

  const absentSince = (id: string) =>
    client.executeRead(async (tx) => {
      const r = await tx.run('MATCH (n {id: $id}) RETURN n._absent_since AS a', { id });
      return (r.records[0]?.get('a') as string | null) ?? null;
    }, DATABASE);

  it("marks only the connector's unseen nodes; fresh and foreign nodes are untouched", async () => {
    await writer.writeNode(workload('api-server', 'k8s-a', '2026-09-16T10:00:00.000Z'), [], {});
    await writer.writeNode(workload('web-ui', 'k8s-a', '2026-09-16T10:05:30.000Z'), [], {});
    await writer.writeNode(workload('redis', 'k8s-b', '2026-09-16T10:00:00.000Z'), [], {});

    const marked = await writer.markAbsent(
      'k8s-a',
      '2026-09-16T10:05:00.000Z',
      '2026-09-16T10:06:00.000Z',
    );

    expect(marked).toBe(1);
    expect(await absentSince('shipit://deployment/default/demo/shipit/deployment/api-server')).toBe(
      '2026-09-16T10:06:00.000Z',
    );
    expect(
      await absentSince('shipit://deployment/default/demo/shipit/deployment/web-ui'),
    ).toBeNull();
    expect(
      await absentSince('shipit://deployment/default/demo/shipit/deployment/redis'),
    ).toBeNull();
    // Idempotent: a second sweep with the same cut-off marks nothing new.
    expect(
      await writer.markAbsent('k8s-a', '2026-09-16T10:05:00.000Z', '2026-09-16T10:07:00.000Z'),
    ).toBe(0);
  });

  it('a later writeNode clears _absent_since', async () => {
    const node = workload('api-server', 'k8s-a', '2026-09-16T10:00:00.000Z');
    await writer.writeNode(node, [], {});
    await writer.markAbsent('k8s-a', '2026-09-16T10:05:00.000Z', '2026-09-16T10:06:00.000Z');
    expect(await absentSince(node.id)).not.toBeNull();

    // expectedClaimsRev 1: the first write bumped `_claims_rev` to 1. (Even a
    // claims-rev conflict would still run the property SET that clears absence.)
    await writer.writeNode({ ...node, _last_synced: '2026-09-16T10:10:00.000Z' }, [], {}, 1);
    expect(await absentSince(node.id)).toBeNull();
  });

  it('touchLastSynced clears _absent_since even when the timestamp does not advance', async () => {
    const node = workload('api-server', 'k8s-a', '2026-09-16T10:00:00.000Z');
    await writer.writeNode(node, [], {});
    await writer.markAbsent('k8s-a', '2026-09-16T10:05:00.000Z', '2026-09-16T10:06:00.000Z');
    await writer.touchLastSynced(node.id, '2026-09-16T09:00:00.000Z');
    expect(await absentSince(node.id)).toBeNull();
  });
});
```

- [ ] **Step 8: Run the integration test (needs a scratch Neo4j)**

Run: `docker compose -f docker/docker-compose.yml up -d neo4j` then
`cd packages/core-writer && NEO4J_TEST_URI=bolt://localhost:7687 NEO4J_TEST_PASSWORD=<local password from docker/docker-compose.yml> npx vitest run src/__tests__/absence.integration.test.ts`
Expected: PASS (3 tests). Without `NEO4J_TEST_URI` the file reports "skipped".

- [ ] **Step 9: Commit**

```bash
git add packages/core-writer/src
git commit -m "core-writer: absence sweep on sync.completed; writes and touches clear _absent_since"
```

---

### Task 4: api-server read paths exclude absent nodes

Implements spec §Absence sweep (read paths, api-server).

**Files:**

- Modify: `packages/api-server/src/services/neo4j-service.ts`
- Modify: `packages/api-server/src/routes/graph.ts`
- Test: `packages/api-server/src/__tests__/services/neo4j-service.test.ts` (extend)
- Test: `packages/api-server/src/__tests__/routes/graph.test.ts` (extend)

**Interfaces:**

- Produces: `interface ReadOptions { includeAbsent?: boolean }`; new trailing `opts?: ReadOptions` on `getGraphStats`, `getNeighborhood`, `getBlastRadius`, `getSources`; `includeAbsent?: boolean` inside the existing option objects of `getOverview` and `searchEntities`. Query param `includeAbsent=true` on `/api/graph/{stats,overview,sources,neighborhood/:id,blast-radius/:id,search}`.

- [ ] **Step 1: Write the failing unit tests**

Append to `packages/api-server/src/__tests__/services/neo4j-service.test.ts`:

```ts
describe('Neo4jService absent-node filtering (unit)', () => {
  function serviceWithSpy() {
    const svc = Object.create(Neo4jService.prototype) as Neo4jService;
    const seen: string[] = [];
    vi.spyOn(
      svc as unknown as { runQuery: typeof Neo4jService.prototype.runQuery },
      'runQuery',
    ).mockImplementation((async (cypher: string) => {
      seen.push(cypher);
      return [] as never;
    }) as never);
    return { svc, seen };
  }

  it('getOverview excludes absent nodes by default and includes them on request', async () => {
    const { svc, seen } = serviceWithSpy();
    await svc.getOverview(SYSTEM_CONTEXT, { limit: 10 });
    expect(seen[0]).toContain('n._absent_since IS NULL');
    await svc.getOverview(SYSTEM_CONTEXT, { limit: 10, includeAbsent: true });
    expect(seen[1]).not.toContain('_absent_since');
  });

  it('searchEntities excludes absent nodes by default and includes them on request', async () => {
    const { svc, seen } = serviceWithSpy();
    await svc.searchEntities(SYSTEM_CONTEXT, { q: 'api' });
    expect(seen[0]).toContain('n._absent_since IS NULL');
    await svc.searchEntities(SYSTEM_CONTEXT, { q: 'api', includeAbsent: true });
    expect(seen[1]).not.toContain('_absent_since');
  });

  it('getSources and getGraphStats node counts exclude absent nodes by default', async () => {
    const { svc, seen } = serviceWithSpy();
    await svc.getSources();
    expect(seen[0]).toContain('n._absent_since IS NULL');
    await svc.getGraphStats(SYSTEM_CONTEXT);
    const labelsQuery = seen.find((q) => q.includes('db.labels()'))!;
    expect(labelsQuery).toContain('n._absent_since IS NULL');
  });

  it('getNeighborhood drops absent nodes and their edges unless includeAbsent', async () => {
    const svc = Object.create(Neo4jService.prototype) as Neo4jService;
    const record = {
      get: (k: string) =>
        k === 'nodes'
          ? [
              { properties: { id: 'a', name: 'a' }, labels: ['Deployment'] },
              {
                properties: { id: 'b', name: 'b', _absent_since: '2026-09-16T10:00:00.000Z' },
                labels: ['Deployment'],
              },
            ]
          : [{ source: 'a', target: 'b', type: 'DEPENDS_ON', props: {} }],
    };
    vi.spyOn(
      svc as unknown as { runQuery: typeof Neo4jService.prototype.runQuery },
      'runQuery',
    ).mockResolvedValue([record] as never);

    const hidden = await svc.getNeighborhood(SYSTEM_CONTEXT, 'a', 1);
    expect(hidden.nodes.map((n) => n.data.id)).toEqual(['a']);
    expect(hidden.edges).toEqual([]);

    const shown = await svc.getNeighborhood(SYSTEM_CONTEXT, 'a', 1, { includeAbsent: true });
    expect(shown.nodes.map((n) => n.data.id)).toEqual(['a', 'b']);
    expect(shown.edges).toHaveLength(1);
  });
});
```

Append to `packages/api-server/src/__tests__/routes/graph.test.ts` (inside `describe('Graph routes')`):

```ts
it('GET /api/graph/overview forwards includeAbsent=true', async () => {
  await server.inject({ method: 'GET', url: '/api/graph/overview?includeAbsent=true' });
  expect(mockNeo4j.getOverview).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ includeAbsent: true }),
  );
});

it('GET /api/graph/search defaults includeAbsent to false', async () => {
  await server.inject({ method: 'GET', url: '/api/graph/search?q=api' });
  expect(mockNeo4j.searchEntities).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ includeAbsent: false }),
  );
});

it('GET /api/graph/blast-radius/:id forwards includeAbsent', async () => {
  await server.inject({ method: 'GET', url: '/api/graph/blast-radius/x?includeAbsent=true' });
  expect(mockNeo4j.getBlastRadius).toHaveBeenLastCalledWith(expect.anything(), 'x', 3, {
    includeAbsent: true,
  });
});
```

(`createMockNeo4jService` in that file already stubs `getOverview`, `searchEntities`, `getBlastRadius`; if `getBlastRadius` is missing there, add `getBlastRadius: vi.fn().mockResolvedValue({ nodes: [], edges: [] })`.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/api-server && npx vitest run src/__tests__/services/neo4j-service.test.ts src/__tests__/routes/graph.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement the filters in `neo4j-service.ts`**

Add after `EXCLUDE_INTERNAL_LABELS` (~line 77):

```ts
// Absence sweep (Kubernetes connector v1): a node the owning connector no longer
// sees carries `_absent_since`. Default reads hide it; `includeAbsent` shows it.
const EXCLUDE_ABSENT = 'n._absent_since IS NULL';
const absentClause = (includeAbsent: boolean | undefined): string =>
  includeAbsent ? '' : ` AND ${EXCLUDE_ABSENT}`;
const isAbsentNode = (props: Record<string, unknown>): boolean =>
  props['_absent_since'] !== null && props['_absent_since'] !== undefined;

export interface ReadOptions {
  /** Include nodes marked absent by the sync sweep. Default false. */
  includeAbsent?: boolean;
}
```

Then, method by method:

1. `getGraphStats(_ctx: RequestContext, opts: ReadOptions = {})` — node counts query becomes:
   ```ts
   `CALL db.labels() YIELD label WHERE NOT label STARTS WITH '_' AND NOT label IN ${INTERNAL_EVENT_LABELS_CYPHER} RETURN label, COUNT { MATCH (n) WHERE label IN labels(n)${absentClause(opts.includeAbsent)} } AS count`;
   ```
2. `getNeighborhood(_ctx, nodeId, depth = 2, opts: ReadOptions = {})` — in the node loop, right after the internal-label check:
   ```ts
   if (!opts.includeAbsent && isAbsentNode(node.properties)) {
     excludedIds.add(id);
     continue;
   }
   ```
3. `getBlastRadius(_ctx, nodeId, depth = 3, opts: ReadOptions = {})` — add `const excludedIds = new Set<string>();` before the loop, the same check as (2) inside the node loop, and skip edges touching `excludedIds` exactly as `getNeighborhood` does (`if (excludedIds.has(source) || excludedIds.has(target)) continue;`).
4. `getOverview` — extend the options type with `includeAbsent?: boolean` and change `sourceWhere` to:
   ```ts
   const sourceWhere =
     (sourceClauses.length ? ` AND ${sourceClauses.join(' AND ')}` : '') +
     absentClause(opts.includeAbsent);
   ```
5. `searchEntities` — add `includeAbsent?: boolean` to `opts`, destructure it, and after the `whereClause` declaration: `if (!includeAbsent) whereClause.push(EXCLUDE_ABSENT);`
6. `getSources(opts: ReadOptions = {})` — `WHERE ${EXCLUDE_INTERNAL_LABELS}${absentClause(opts.includeAbsent)}` (keep the `AND n._source_system IS NOT NULL` line after it).

- [ ] **Step 4: Routes**

In `packages/api-server/src/routes/graph.ts` add a helper at the top of the plugin body:

```ts
const includeAbsent = (q: { includeAbsent?: string } | undefined): boolean =>
  q?.includeAbsent === 'true';
```

and thread it: `/stats` → `neo4j.getGraphStats(request.ctx, { includeAbsent: includeAbsent(request.query) })` (add `Querystring: { includeAbsent?: string }`); `/overview` → add `includeAbsent?: string` to its Querystring and pass `includeAbsent: includeAbsent(request.query)` in the options object; `/sources` → `neo4j.getSources({ includeAbsent: includeAbsent(request.query) })`; `/neighborhood/:id` and `/blast-radius/:id` → add `includeAbsent?: string` to Querystring and pass `{ includeAbsent: includeAbsent(request.query) }` as the 4th argument; `/search` → add `includeAbsent?: string` to Querystring and `includeAbsent: includeAbsent(request.query)` in the `searchEntities` options.

- [ ] **Step 5: Run the tests**

Run: `cd packages/api-server && npx vitest run src/__tests__/services/neo4j-service.test.ts src/__tests__/routes/graph.test.ts src/__tests__/services/blast-radius-ownership.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/api-server/src/services/neo4j-service.ts packages/api-server/src/routes/graph.ts packages/api-server/src/__tests__
git commit -m "api-server: hide absent nodes from graph reads unless includeAbsent"
```

---

### Task 5: MCP tools exclude absent nodes (`include_absent`)

Implements spec §Absence sweep (read paths, MCP).

**Files:**

- Modify: `packages/mcp-server/src/cypher/generator.ts`
- Modify: `packages/mcp-server/src/tools/blast-radius.ts`, `entity-detail.ts`, `search-entities.ts`, `dependency-chain.ts`
- Modify: `packages/mcp-server/src/tools/metadata.ts`
- Test: `packages/mcp-server/src/__tests__/cypher-generator.test.ts` (extend)
- Test: `packages/mcp-server/src/__tests__/metadata.test.ts` (extend; create if absent)

**Interfaces:**

- Produces: trailing `includeAbsent = false` parameter on `generateBlastRadiusCypher`, `generateEntityDetailCypher`, `generateDependencyChainCypher`, `generateSearchEntitiesCypher`; `generateGraphStatsCypher` always excludes absent; tool argument `include_absent: boolean` (default `false`) on `blast_radius`, `entity_detail`, `search_entities`, `dependency_chain`; `INCLUDE_ABSENT_PARAM` metadata entry on those four tools.

- [ ] **Step 1: Write the failing tests**

Append to `packages/mcp-server/src/__tests__/cypher-generator.test.ts` (inside the top-level `describe('Cypher Generator')`):

```ts
describe('absent-node filtering (sync sweep)', () => {
  const id = 'shipit://repository/default/Ship-It-Ops/ShipIt-AI';

  it('blast radius excludes absent nodes by default and includes them on request', () => {
    expect(generateBlastRadiusCypher(id, 2, 'BOTH').query).toContain('n._absent_since IS NULL');
    expect(generateBlastRadiusCypher(id, 2, 'BOTH', undefined, true).query).not.toContain(
      '_absent_since',
    );
  });

  it('entity detail neighbors exclude absent nodes by default', () => {
    expect(generateEntityDetailCypher(id, true).query).toContain(
      'WHERE neighbor._absent_since IS NULL',
    );
    expect(generateEntityDetailCypher(id, true, true).query).not.toContain('_absent_since');
    // The entity itself is never filtered: asking for an absent node by id still works.
    expect(generateEntityDetailCypher(id, false).query).not.toContain('_absent_since');
  });

  it('dependency chain refuses paths through absent nodes by default', () => {
    expect(generateDependencyChainCypher(id, 'x', 3).query).toContain(
      'none(x IN nodes(path) WHERE x._absent_since IS NOT NULL)',
    );
    expect(generateDependencyChainCypher(id, 'x', 3, true).query).not.toContain('_absent_since');
  });

  it('search excludes absent nodes by default, also when no other filter is set', () => {
    expect(generateSearchEntitiesCypher().query).toContain('WHERE n._absent_since IS NULL');
    expect(
      generateSearchEntitiesCypher(undefined, undefined, 25, 'name', true).query,
    ).not.toContain('_absent_since');
  });

  it('graph stats always exclude absent nodes and their edges', () => {
    const q = generateGraphStatsCypher().query;
    expect(q).toContain('MATCH (n) WHERE n._absent_since IS NULL');
    expect(q).toContain('a._absent_since IS NULL AND b._absent_since IS NULL');
    expect(q).toContain('MATCH (d:Deployment) WHERE d._absent_since IS NULL');
  });
});
```

Create (or extend) `packages/mcp-server/src/__tests__/metadata.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { MCP_TOOL_BY_NAME } from '../tools/metadata.js';

describe('MCP tool metadata — include_absent', () => {
  it.each(['blast_radius', 'entity_detail', 'search_entities', 'dependency_chain'])(
    '%s documents include_absent (boolean, default false)',
    (tool) => {
      const param = MCP_TOOL_BY_NAME[tool as keyof typeof MCP_TOOL_BY_NAME].params.find(
        (p) => p.name === 'include_absent',
      );
      expect(param).toMatchObject({ type: 'boolean', required: false, default: 'false' });
    },
  );

  it('graph_stats and schema_info do not expose include_absent', () => {
    for (const tool of ['graph_stats', 'schema_info'] as const) {
      expect(MCP_TOOL_BY_NAME[tool].params.some((p) => p.name === 'include_absent')).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/mcp-server && npx vitest run src/__tests__/cypher-generator.test.ts src/__tests__/metadata.test.ts`
Expected: FAIL on the new cases.

- [ ] **Step 3: Generator changes**

In `packages/mcp-server/src/cypher/generator.ts`:

`generateBlastRadiusCypher(node, depth, direction, includeEnvironments?, includeAbsent = false)` — add after the env filter block:

```ts
const absentFilter = includeAbsent ? '' : `\n      AND n._absent_since IS NULL`;
```

and use `WHERE n <> start${envFilter}${absentFilter}`.

`generateEntityDetailCypher(entityId, includeNeighbors, includeAbsent = false)` — neighbors branch:

```ts
      MATCH (n {id: $entityId})
      OPTIONAL MATCH (n)-[r]-(neighbor)${includeAbsent ? '' : ' WHERE neighbor._absent_since IS NULL'}
```

`generateDependencyChainCypher(from, to, maxDepth, includeAbsent = false)`:

```ts
      MATCH (start {id: $from}), (end {id: $to})
      MATCH path = shortestPath((start)-[*1..${maxDepth}]-(end))
      ${includeAbsent ? '' : 'WHERE none(x IN nodes(path) WHERE x._absent_since IS NOT NULL)'}
      RETURN path,
```

`generateSearchEntitiesCypher(label?, propertyFilters?, limit = 25, sortBy = 'name', includeAbsent = false)` — after the property-filter loop:

```ts
if (!includeAbsent) whereClauses.push('n._absent_since IS NULL');
```

`generateGraphStatsCypher()` — the three subqueries become:

```cypher
      CALL {
        MATCH (n) WHERE n._absent_since IS NULL
        UNWIND labels(n) AS label
        RETURN label, count(*) AS cnt
      }
      ...
      CALL {
        MATCH (a)-[r]->(b) WHERE a._absent_since IS NULL AND b._absent_since IS NULL
        RETURN type(r) AS rel_type, count(*) AS cnt
      }
      ...
      CALL {
        MATCH (d:Deployment) WHERE d._absent_since IS NULL
        RETURN collect(DISTINCT d.environment) AS environments
      }
```

- [ ] **Step 4: Tool arguments**

In each of `blast-radius.ts`, `entity-detail.ts`, `search-entities.ts`, `dependency-chain.ts` add to the zod shape (before `compact`):

```ts
      include_absent: z
        .boolean()
        .default(false)
        .describe(
          'Include entities the owning connector no longer sees (marked absent by the sync sweep). Default false.',
        ),
```

destructure `include_absent` from `params`, and pass it as the new trailing argument: `generateBlastRadiusCypher(node, depth, direction, environments, include_absent)`, `generateEntityDetailCypher(entity, include_neighbors, include_absent)`, `generateSearchEntitiesCypher(label, property_filters as ..., limit, sort_by, include_absent)`, `generateDependencyChainCypher(from, to, max_depth, include_absent)`.

- [ ] **Step 5: Metadata**

In `packages/mcp-server/src/tools/metadata.ts` add beside `COMPACT_PARAM`:

```ts
const INCLUDE_ABSENT_PARAM: McpToolParamSpec = {
  name: 'include_absent',
  type: 'boolean',
  required: false,
  description:
    'Include entities the owning connector no longer sees (marked absent by the sync sweep).',
  default: 'false',
};
```

and insert `INCLUDE_ABSENT_PARAM,` immediately before `COMPACT_PARAM` in the `params` arrays of `blast_radius`, `entity_detail`, `search_entities` and `dependency_chain`. Add a `#### include_absent` sentence to each of those four tool sections in `docs/mcp-tools.md`: "`include_absent` (boolean, default false): include entities the owning connector no longer sees (marked absent by the sync sweep)."

- [ ] **Step 6: Run the tests**

Run: `cd packages/mcp-server && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/mcp-server/src docs/mcp-tools.md
git commit -m "mcp-server: exclude absent nodes by default; include_absent on traversal and search tools"
```

---

### Task 6: Connector package — identity, environment and linking (pure modules)

Implements spec §Data model (ids, linking keys), §Service identity, §Repository linking tiers, §Environment derivation, §Ownership. One refinement over the spec text: the name-match tiers compare against a **known-name list** the api-server passes in (`knownRepositories` / `knownTeams`, resolved from Neo4j at build time, Task 11), so the predicted id carries the repository's real casing (`ShipIt-AI`, not `shipit-ai`). The writer's MATCH-on-both-ends drop remains the backstop.

**Files:**

- Create: `packages/connectors/kubernetes/src/types.ts`
- Create: `packages/connectors/kubernetes/src/normalizers/identity.ts`
- Create: `packages/connectors/kubernetes/src/normalizers/environment.ts`
- Create: `packages/connectors/kubernetes/src/normalizers/linking.ts`
- Test: `packages/connectors/kubernetes/src/__tests__/identity.test.ts`, `environment.test.ts`, `linking.test.ts`

**Interfaces:**

- Consumes: `KubernetesMappingConfig`, `KubernetesWorkloadKind` (Task 2); `buildCanonicalId`, `buildScopedCanonicalId`, `buildLinkingKey` from `@shipit-ai/shared`.
- Produces: everything exported below (used by Task 7's normalizers and Task 9's connector).

- [ ] **Step 1: Write the failing tests**

`packages/connectors/kubernetes/src/__tests__/identity.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  ids,
  keys,
  parseImageRef,
  normalizeServiceName,
  slugify,
} from '../normalizers/identity.js';

describe('parseImageRef', () => {
  it('parses a registry-qualified reference with tag', () => {
    expect(
      parseImageRef(
        'us-central1-docker.pkg.dev/ship-it-ai-portal/shipit-ai/api-server:sha-97189de',
      ),
    ).toEqual({
      registry: 'us-central1-docker.pkg.dev',
      repository: 'ship-it-ai-portal/shipit-ai/api-server',
      tag: 'sha-97189de',
      digest: undefined,
      name: 'api-server',
    });
  });

  it('defaults docker.io/library for bare official images and keeps a digest', () => {
    expect(parseImageRef('redis:7-alpine')).toMatchObject({
      registry: 'docker.io',
      repository: 'library/redis',
      tag: '7-alpine',
      name: 'redis',
    });
    const withDigest = parseImageRef(
      'ghcr.io/acme/web@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );
    expect(withDigest.digest).toBe(
      'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    );
    expect(withDigest.tag).toBeUndefined();
    expect(withDigest.registry).toBe('ghcr.io');
  });

  it('treats host:port as a registry and docker.io/<user>/<name> as a user image', () => {
    expect(parseImageRef('localhost:5000/team/app:1')).toMatchObject({
      registry: 'localhost:5000',
      repository: 'team/app',
      tag: '1',
    });
    expect(parseImageRef('bitnami/redis')).toMatchObject({
      registry: 'docker.io',
      repository: 'bitnami/redis',
      name: 'redis',
    });
  });
});

describe('ids and keys', () => {
  it('scopes namespace and deployment ids by cluster and keeps global ids global', () => {
    expect(ids.cluster('shipit-demo')).toBe('shipit://cluster/default/shipit-demo');
    expect(ids.namespace('shipit-demo', 'shipit')).toBe(
      'shipit://namespace/default/shipit-demo/shipit',
    );
    expect(ids.deployment('shipit-demo', 'shipit', 'StatefulSet', 'redis')).toBe(
      'shipit://deployment/default/shipit-demo/shipit/statefulset/redis',
    );
    expect(ids.environment('production')).toBe('shipit://environment/default/production');
    expect(ids.logicalService('ShipIt AI')).toBe('shipit://logical-service/default/shipit-ai');
    expect(ids.repository('Ship-It-Ops', 'ShipIt-AI')).toBe(
      'shipit://repository/default/Ship-It-Ops/ShipIt-AI',
    );
    expect(ids.team('Ship-It-Ops', 'platform')).toBe('shipit://team/default/Ship-It-Ops/platform');
    expect(ids.buildArtifact(parseImageRef('redis:7-alpine'))).toBe(
      'shipit://build-artifact/default/docker.io/library/redis@7-alpine',
    );
  });

  it('builds every linking key under the k8s:// prefix', () => {
    expect(keys.cluster('c')).toBe('k8s://c');
    expect(keys.workload('c', 'ns', 'Deployment', 'api')).toBe('k8s://c/ns/deployment/api');
    expect(keys.environment('c', 'prod')).toBe('k8s://c/environment/prod');
    expect(keys.service('c', 'ShipIt AI')).toBe('k8s://c/service/shipit-ai');
    expect(keys.image('c', parseImageRef('redis:7-alpine'))).toBe(
      'k8s://c/image/docker.io/library/redis@7-alpine',
    );
  });

  it('normalizes service names and slugs', () => {
    expect(normalizeServiceName('  Payments API ')).toBe('payments-api');
    expect(normalizeServiceName('shipit-ai/api-server')).toBe('shipit-ai/api-server');
    expect(slugify('Platform Team')).toBe('platform-team');
  });
});
```

`packages/connectors/kubernetes/src/__tests__/environment.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { deriveEnvironment, environmentType } from '../normalizers/environment.js';

const mapping = {
  label: 'environment',
  namespaceRules: [
    { pattern: '^(prod|production)', environment: 'production' },
    { pattern: '^(stag|staging)', environment: 'staging' },
  ],
  default: null as string | null,
};

describe('deriveEnvironment', () => {
  it('prefers the workload label, then the namespace label, then rules, then default', () => {
    expect(
      deriveEnvironment({
        workloadLabels: { environment: 'staging' },
        namespaceLabels: { environment: 'production' },
        namespaceName: 'production',
        mapping,
      }),
    ).toEqual({ environment: 'staging', derivedFrom: 'label', confidence: 0.95 });
    expect(
      deriveEnvironment({
        workloadLabels: {},
        namespaceLabels: { env: 'production' },
        namespaceName: 'x',
        mapping,
      }),
    ).toEqual({ environment: 'production', derivedFrom: 'namespace-label', confidence: 0.95 });
    expect(
      deriveEnvironment({
        workloadLabels: {},
        namespaceLabels: {},
        namespaceName: 'prod-eu',
        mapping,
      }),
    ).toEqual({ environment: 'production', derivedFrom: 'namespace-rule', confidence: 0.8 });
    expect(
      deriveEnvironment({
        workloadLabels: {},
        namespaceLabels: {},
        namespaceName: 'shipit',
        mapping: { ...mapping, default: 'sandbox' },
      }),
    ).toEqual({ environment: 'sandbox', derivedFrom: 'default', confidence: 0.6 });
  });

  it('returns null when nothing matches and there is no default', () => {
    expect(
      deriveEnvironment({
        workloadLabels: {},
        namespaceLabels: {},
        namespaceName: 'shipit',
        mapping,
      }),
    ).toBeNull();
  });

  it('maps only the three schema environment types', () => {
    expect(environmentType('Production')).toBe('production');
    expect(environmentType('sandbox')).toBeUndefined();
  });
});
```

`packages/connectors/kubernetes/src/__tests__/linking.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { resolveRepositoryLink, resolveTeamLink } from '../normalizers/linking.js';
import { parseImageRef } from '../normalizers/identity.js';

const mapping = {
  annotation: 'shipit.ai/github-repo',
  githubOrg: null as string | null,
  nameMatch: true,
};
const base = {
  annotations: {},
  namespaceAnnotations: {},
  labels: {},
  images: [] as ReturnType<typeof parseImageRef>[],
  mapping,
  knownRepositories: ['ShipIt-AI', 'api-server'],
  githubOrg: 'Ship-It-Ops' as string | null,
};

describe('resolveRepositoryLink', () => {
  it('tier 1: the workload annotation wins at confidence 1.0 with the exact org/repo', () => {
    const r = resolveRepositoryLink({
      ...base,
      annotations: { 'shipit.ai/github-repo': 'Ship-It-Ops/ShipIt-AI' },
      labels: { 'app.kubernetes.io/name': 'something-else' },
    });
    expect(r.link).toEqual({
      org: 'Ship-It-Ops',
      repo: 'ShipIt-AI',
      confidence: 1.0,
      linkMethod: 'annotation',
    });
    expect(r.warnings).toEqual([]);
  });

  it('tier 1 falls back to the namespace annotation', () => {
    const r = resolveRepositoryLink({
      ...base,
      namespaceAnnotations: { 'shipit.ai/github-repo': 'Ship-It-Ops/ShipIt-AI' },
    });
    expect(r.link?.linkMethod).toBe('annotation');
  });

  it('a malformed annotation is ignored with a warning and the tiers continue', () => {
    const r = resolveRepositoryLink({
      ...base,
      annotations: { 'shipit.ai/github-repo': 'not a slug' },
      images: [parseImageRef('us-central1-docker.pkg.dev/p/shipit-ai/api-server:sha-1')],
    });
    expect(r.warnings[0]).toMatch(/ignored shipit.ai\/github-repo="not a slug"/);
    expect(r.link).toEqual({
      org: 'Ship-It-Ops',
      repo: 'api-server',
      confidence: 0.7,
      linkMethod: 'image-name',
    });
  });

  it('tier 3: app label matches a known repository case-insensitively and uses the known casing', () => {
    const r = resolveRepositoryLink({ ...base, labels: { 'app.kubernetes.io/name': 'shipit-ai' } });
    expect(r.link).toEqual({
      org: 'Ship-It-Ops',
      repo: 'ShipIt-AI',
      confidence: 0.6,
      linkMethod: 'app-label',
    });
  });

  it('tier 3 also accepts app.kubernetes.io/part-of', () => {
    const r = resolveRepositoryLink({
      ...base,
      labels: { 'app.kubernetes.io/part-of': 'SHIPIT-AI' },
    });
    expect(r.link?.repo).toBe('ShipIt-AI');
  });

  it('name tiers are disabled with a warning when githubOrg is unresolved, and when nameMatch is off', () => {
    const noOrg = resolveRepositoryLink({
      ...base,
      githubOrg: null,
      labels: { 'app.kubernetes.io/name': 'shipit-ai' },
    });
    expect(noOrg.link).toBeNull();
    expect(noOrg.warnings[0]).toMatch(/githubOrg unresolved/);
    const off = resolveRepositoryLink({
      ...base,
      mapping: { ...mapping, nameMatch: false },
      labels: { 'app.kubernetes.io/name': 'shipit-ai' },
    });
    expect(off.link).toBeNull();
    expect(off.warnings).toEqual([]);
  });

  it('returns null without warnings when nothing matches', () => {
    const r = resolveRepositoryLink({ ...base, labels: { 'app.kubernetes.io/name': 'unknown' } });
    expect(r).toEqual({ link: null, warnings: [] });
  });
});

describe('resolveTeamLink', () => {
  it('slugifies the label and returns the known team slug at 0.85', () => {
    const r = resolveTeamLink({
      labels: { team: 'Platform Team' },
      namespaceLabels: {},
      teamLabel: 'team',
      knownTeams: ['platform-team'],
      githubOrg: 'Ship-It-Ops',
    });
    expect(r.link).toEqual({
      org: 'Ship-It-Ops',
      slug: 'platform-team',
      confidence: 0.85,
      derivedFrom: 'label',
    });
  });

  it('falls back to the namespace label and warns on an unknown team', () => {
    const r = resolveTeamLink({
      labels: {},
      namespaceLabels: { team: 'payments' },
      teamLabel: 'team',
      knownTeams: ['platform-team'],
      githubOrg: 'Ship-It-Ops',
    });
    expect(r.link).toBeNull();
    expect(r.warnings[0]).toMatch(/matches no GitHub team/);
    const ok = resolveTeamLink({
      labels: {},
      namespaceLabels: { team: 'payments' },
      teamLabel: 'team',
      knownTeams: ['payments'],
      githubOrg: 'Ship-It-Ops',
    });
    expect(ok.link?.derivedFrom).toBe('namespace-label');
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/connectors/kubernetes && npx vitest run`
Expected: FAIL — modules not found.

- [ ] **Step 3: `types.ts`**

Create `packages/connectors/kubernetes/src/types.ts`:

```ts
import type {
  V1CronJob,
  V1DaemonSet,
  V1Deployment,
  V1Namespace,
  V1StatefulSet,
} from '@kubernetes/client-node';
import type {
  CanonicalEdge,
  CanonicalNode,
  KubernetesMappingConfig,
  KubernetesWorkloadKind,
} from '@shipit-ai/shared';

export type WorkloadKind = KubernetesWorkloadKind;
export type WorkloadObject = V1Deployment | V1StatefulSet | V1DaemonSet | V1CronJob;

/** Cluster summary assembled by fetchers/cluster.ts (one per run). */
export interface RawCluster {
  __shipit: 'cluster';
  name: string;
  version?: string;
  provider?: string;
  region?: string;
}

export interface RawNamespace {
  __shipit: 'namespace';
  object: V1Namespace;
}

/** What the workload normalizer needs to know about the enclosing namespace. */
export interface NamespaceRef {
  name: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
}

/** Per-workload rollup of its pods (one pod list per namespace, matched in memory). */
export interface PodSummary {
  readyPods: number;
  restarts: number;
  /** container name → image digest (`sha256:…`) from `status.containerStatuses[].imageID`. */
  imageDigests: Record<string, string>;
}

export const EMPTY_POD_SUMMARY: PodSummary = { readyPods: 0, restarts: 0, imageDigests: {} };

export interface RawWorkload {
  __shipit: 'workload';
  kind: WorkloadKind;
  object: WorkloadObject;
  namespace: NamespaceRef;
  pods: PodSummary;
}

/** Every record `fetch()` hands to `normalize()`; `__shipit` is the dispatch key. */
export type RawRecord = RawCluster | RawNamespace | RawWorkload;

export interface NormalizerContext {
  cluster: string;
  mapping: KubernetesMappingConfig;
  /** Resolved GitHub org for predicted Repository/Team ids; null disables name tiers. */
  githubOrg: string | null;
  /** Repository names (source casing) already in the graph for `githubOrg`. */
  knownRepositories: string[];
  /** Team slugs already in the graph for `githubOrg`. */
  knownTeams: string[];
  /** ISO timestamp used for `_last_synced` / claim `ingested_at` of this normalize() call. */
  now: string;
}

export interface NormalizeOutput {
  nodes: CanonicalNode[];
  edges: CanonicalEdge[];
  warnings: string[];
}
```

- [ ] **Step 4: `normalizers/identity.ts`**

```ts
import { buildCanonicalId, buildScopedCanonicalId, buildLinkingKey } from '@shipit-ai/shared';
import type { WorkloadKind } from '../types.js';

export interface ParsedImage {
  /** Registry host; `docker.io` when the reference has none. */
  registry: string;
  /** Repository path without the registry, e.g. `ship-it-ai-portal/shipit-ai/api-server`. */
  repository: string;
  tag?: string;
  digest?: string;
  /** Last path segment of `repository` — the image-name linking signal. */
  name: string;
}

const DIGEST_RE = /@(sha256:[a-f0-9]{64})$/;

/** Split an OCI image reference into registry / repository / tag / digest. */
export function parseImageRef(ref: string): ParsedImage {
  let rest = ref.trim();
  let digest: string | undefined;
  const d = rest.match(DIGEST_RE);
  if (d) {
    digest = d[1];
    rest = rest.slice(0, -d[0].length);
  }
  let tag: string | undefined;
  const lastSlash = rest.lastIndexOf('/');
  const lastColon = rest.lastIndexOf(':');
  if (lastColon > lastSlash) {
    tag = rest.slice(lastColon + 1);
    rest = rest.slice(0, lastColon);
  }
  const firstSlash = rest.indexOf('/');
  const firstSegment = firstSlash === -1 ? '' : rest.slice(0, firstSlash);
  const looksLikeRegistry =
    firstSegment.includes('.') || firstSegment.includes(':') || firstSegment === 'localhost';
  let registry = 'docker.io';
  let repository = rest;
  if (looksLikeRegistry) {
    registry = firstSegment;
    repository = rest.slice(firstSlash + 1);
  } else if (firstSlash === -1) {
    repository = `library/${rest}`;
  }
  const name = repository.slice(repository.lastIndexOf('/') + 1);
  return { registry, repository, tag, digest, name };
}

/** Lower-case, `[a-z0-9._/-]` only — the LogicalService id segment. */
export function normalizeServiceName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** GitHub-team-slug style: lower-case, spaces → `-`, `[a-z0-9._-]` only. */
export function slugify(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function imageIdentity(image: ParsedImage): string {
  return `${image.registry}/${image.repository}@${image.digest ?? image.tag ?? 'latest'}`;
}

/** Canonical ids. Cluster-scoped where the spec says so; Environment / LogicalService /
 *  BuildArtifact are global so later sources merge by primary key. */
export const ids = {
  cluster: (cluster: string) => buildCanonicalId('Cluster', 'default', cluster),
  namespace: (cluster: string, ns: string) =>
    buildScopedCanonicalId('Namespace', 'default', cluster, ns),
  deployment: (cluster: string, ns: string, kind: WorkloadKind, name: string) =>
    buildScopedCanonicalId('Deployment', 'default', cluster, `${ns}/${kind.toLowerCase()}/${name}`),
  environment: (env: string) => buildCanonicalId('Environment', 'default', env),
  logicalService: (serviceName: string) =>
    buildCanonicalId('LogicalService', 'default', normalizeServiceName(serviceName)),
  buildArtifact: (image: ParsedImage) =>
    buildCanonicalId('BuildArtifact', 'default', imageIdentity(image)),
  repository: (org: string, name: string) =>
    buildScopedCanonicalId('Repository', 'default', org, name),
  team: (org: string, slug: string) => buildScopedCanonicalId('Team', 'default', org, slug),
};

/** Linking keys (`_source_id`). Always `k8s://<cluster>/…` so `parseLinkingKey` accepts them. */
export const keys = {
  cluster: (cluster: string) => buildLinkingKey('kubernetes', cluster),
  namespace: (cluster: string, ns: string) => buildLinkingKey('kubernetes', cluster, ns),
  workload: (cluster: string, ns: string, kind: WorkloadKind, name: string) =>
    buildLinkingKey('kubernetes', cluster, ns, kind.toLowerCase(), name),
  environment: (cluster: string, env: string) =>
    buildLinkingKey('kubernetes', cluster, 'environment', env),
  service: (cluster: string, serviceName: string) =>
    buildLinkingKey('kubernetes', cluster, 'service', normalizeServiceName(serviceName)),
  image: (cluster: string, image: ParsedImage) =>
    buildLinkingKey('kubernetes', cluster, 'image', imageIdentity(image)),
};
```

- [ ] **Step 5: `normalizers/environment.ts`**

```ts
import type { KubernetesMappingConfig } from '@shipit-ai/shared';

export type EnvironmentSource = 'label' | 'namespace-label' | 'namespace-rule' | 'default';

export interface EnvironmentDerivation {
  environment: string;
  derivedFrom: EnvironmentSource;
  confidence: number;
}

export const ENVIRONMENT_TYPES = ['development', 'staging', 'production'] as const;
export type EnvironmentType = (typeof ENVIRONMENT_TYPES)[number];

const CONFIDENCE: Record<EnvironmentSource, number> = {
  label: 0.95,
  'namespace-label': 0.95,
  'namespace-rule': 0.8,
  default: 0.6,
};

function readLabel(labels: Record<string, string>, key: string): string | undefined {
  const direct = labels[key]?.trim();
  if (direct) return direct;
  if (key !== 'env') {
    const alias = labels['env']?.trim();
    if (alias) return alias;
  }
  return undefined;
}

/**
 * Spec §Environment derivation: workload label → namespace label → namespace-name
 * rule → configured default → null (no Environment node, no RUNS_IN_ENV edge).
 */
export function deriveEnvironment(input: {
  workloadLabels: Record<string, string>;
  namespaceLabels: Record<string, string>;
  namespaceName: string;
  mapping: KubernetesMappingConfig['environment'];
}): EnvironmentDerivation | null {
  const { mapping } = input;
  const fromWorkload = readLabel(input.workloadLabels, mapping.label);
  if (fromWorkload)
    return { environment: fromWorkload, derivedFrom: 'label', confidence: CONFIDENCE.label };
  const fromNamespace = readLabel(input.namespaceLabels, mapping.label);
  if (fromNamespace) {
    return {
      environment: fromNamespace,
      derivedFrom: 'namespace-label',
      confidence: CONFIDENCE['namespace-label'],
    };
  }
  for (const rule of mapping.namespaceRules) {
    if (new RegExp(rule.pattern).test(input.namespaceName)) {
      return {
        environment: rule.environment,
        derivedFrom: 'namespace-rule',
        confidence: CONFIDENCE['namespace-rule'],
      };
    }
  }
  if (mapping.default) {
    return { environment: mapping.default, derivedFrom: 'default', confidence: CONFIDENCE.default };
  }
  return null;
}

/** The schema's `Environment.type` enum; anything else is omitted. */
export function environmentType(name: string): EnvironmentType | undefined {
  const lower = name.toLowerCase();
  return (ENVIRONMENT_TYPES as readonly string[]).includes(lower)
    ? (lower as EnvironmentType)
    : undefined;
}
```

- [ ] **Step 6: `normalizers/linking.ts`**

```ts
import type { KubernetesMappingConfig } from '@shipit-ai/shared';
import { slugify, type ParsedImage } from './identity.js';

export type LinkMethod = 'annotation' | 'image-name' | 'app-label';

export interface RepositoryLink {
  org: string;
  repo: string;
  confidence: number;
  linkMethod: LinkMethod;
}

export interface LinkResult<T> {
  link: T | null;
  warnings: string[];
}

export interface RepositoryLinkInput {
  annotations: Record<string, string>;
  namespaceAnnotations: Record<string, string>;
  labels: Record<string, string>;
  images: ParsedImage[];
  mapping: KubernetesMappingConfig['repoLink'];
  /** Repository names already in the graph for `githubOrg` (source casing). */
  knownRepositories: string[];
  githubOrg: string | null;
}

const ANNOTATION_VALUE = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const CONFIDENCE: Record<LinkMethod, number> = {
  annotation: 1.0,
  'image-name': 0.7,
  'app-label': 0.6,
};

function findKnown(candidate: string, known: string[]): string | undefined {
  const lower = candidate.toLowerCase();
  return known.find((k) => k.toLowerCase() === lower);
}

/**
 * Spec §Repository linking tiers. Tier 1 needs no graph knowledge (the operator
 * names the repo). Tiers 2–3 need `githubOrg` and compare against
 * `knownRepositories` so the predicted id carries the repo's real casing.
 */
export function resolveRepositoryLink(input: RepositoryLinkInput): LinkResult<RepositoryLink> {
  const warnings: string[] = [];
  const key = input.mapping.annotation;
  const raw = input.annotations[key] ?? input.namespaceAnnotations[key];
  if (raw !== undefined) {
    const m = raw.trim().match(ANNOTATION_VALUE);
    if (m) {
      return {
        link: {
          org: m[1],
          repo: m[2],
          confidence: CONFIDENCE.annotation,
          linkMethod: 'annotation',
        },
        warnings,
      };
    }
    warnings.push(`ignored ${key}="${raw}": expected <org>/<repo>`);
  }
  if (!input.mapping.nameMatch) return { link: null, warnings };
  if (!input.githubOrg) {
    warnings.push(
      'repoLink.githubOrg unresolved: name-match tiers disabled (set mapping.repoLink.githubOrg or configure exactly one GitHub connector)',
    );
    return { link: null, warnings };
  }
  for (const image of input.images) {
    const hit = findKnown(image.name, input.knownRepositories);
    if (hit) {
      return {
        link: {
          org: input.githubOrg,
          repo: hit,
          confidence: CONFIDENCE['image-name'],
          linkMethod: 'image-name',
        },
        warnings,
      };
    }
  }
  const appName =
    input.labels['app.kubernetes.io/name'] ?? input.labels['app.kubernetes.io/part-of'];
  if (appName) {
    const hit = findKnown(appName, input.knownRepositories);
    if (hit) {
      return {
        link: {
          org: input.githubOrg,
          repo: hit,
          confidence: CONFIDENCE['app-label'],
          linkMethod: 'app-label',
        },
        warnings,
      };
    }
  }
  return { link: null, warnings };
}

export interface TeamLink {
  org: string;
  slug: string;
  confidence: number;
  derivedFrom: 'label' | 'namespace-label';
}

/** Spec §Ownership: team label on the workload, else namespace; slugified; must be a known team. */
export function resolveTeamLink(input: {
  labels: Record<string, string>;
  namespaceLabels: Record<string, string>;
  teamLabel: string;
  knownTeams: string[];
  githubOrg: string | null;
}): LinkResult<TeamLink> {
  const warnings: string[] = [];
  const fromWorkload = input.labels[input.teamLabel]?.trim();
  const fromNamespace = input.namespaceLabels[input.teamLabel]?.trim();
  const raw = fromWorkload || fromNamespace;
  if (!raw) return { link: null, warnings };
  if (!input.githubOrg) {
    warnings.push(`team label "${raw}" ignored: repoLink.githubOrg unresolved`);
    return { link: null, warnings };
  }
  const hit = findKnown(slugify(raw), input.knownTeams);
  if (!hit) {
    warnings.push(`team label "${raw}" matches no GitHub team in ${input.githubOrg}`);
    return { link: null, warnings };
  }
  return {
    link: {
      org: input.githubOrg,
      slug: hit,
      confidence: 0.85,
      derivedFrom: fromWorkload ? 'label' : 'namespace-label',
    },
    warnings,
  };
}
```

- [ ] **Step 7: Run the tests + typecheck**

Run: `cd packages/connectors/kubernetes && npx vitest run && npx tsc --noEmit`
Expected: PASS, clean. (`@kubernetes/client-node` is already a dependency; `pnpm install` is not needed.)

- [ ] **Step 8: Commit**

```bash
git add packages/connectors/kubernetes/src
git commit -m "connector-kubernetes: identity, environment derivation and tiered linking (pure modules)"
```

---

### Task 7: Connector package — normalizers + fixtures

Implements spec §Data model (nodes/edges), §Service identity.

**Files:**

- Create: `packages/connectors/kubernetes/src/normalizers/claims.ts`
- Create: `packages/connectors/kubernetes/src/normalizers/cluster.ts`
- Create: `packages/connectors/kubernetes/src/normalizers/namespace.ts`
- Create: `packages/connectors/kubernetes/src/normalizers/workload.ts`
- Create: `packages/connectors/kubernetes/src/__tests__/fixtures/demo-cluster.ts`
- Test: `packages/connectors/kubernetes/src/__tests__/normalizers.test.ts`

**Interfaces:**

- Consumes: Task 6 modules; `deriveContentVersion`, `PropertyClaim`, `CanonicalNode`, `CanonicalEdge` from shared.
- Produces: `normalizeCluster(raw: RawCluster, ctx: NormalizerContext): NormalizeOutput`; `normalizeNamespace(raw: RawNamespace, ctx): NormalizeOutput`; `normalizeWorkload(raw: RawWorkload, ctx): NormalizeOutput`; `workloadShape(raw: RawWorkload)`; `deriveServiceName(...)`; fixtures `demoNamespace`, `apiServerDeployment`, `redisStatefulSet`, `nodeExporterDaemonSet`, `backupCronJob`, `demoContext`, `rawWorkload(...)`.

- [ ] **Step 1: Write the fixture**

Create `packages/connectors/kubernetes/src/__tests__/fixtures/demo-cluster.ts` (mirrors the real demo chart: chart-wide `app.kubernetes.io/name: shipit-ai`, one component per workload, Artifact Registry images tagged by SHA):

```ts
import type { V1CronJob, V1DaemonSet, V1Deployment, V1StatefulSet } from '@kubernetes/client-node';
import type {
  NamespaceRef,
  NormalizerContext,
  PodSummary,
  RawWorkload,
  WorkloadKind,
  WorkloadObject,
} from '../../types.js';
import { EMPTY_POD_SUMMARY } from '../../types.js';

export const CLUSTER = 'shipit-demo';
export const NOW = '2026-09-16T12:00:00.000Z';

export const demoNamespace: NamespaceRef = {
  name: 'shipit',
  labels: { environment: 'production', team: 'Platform Team' },
  annotations: {},
};

export const apiServerDeployment: V1Deployment = {
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: {
    name: 'api-server',
    namespace: 'shipit',
    uid: 'uid-api-server',
    creationTimestamp: new Date('2026-06-10T08:00:00.000Z'),
    labels: {
      'app.kubernetes.io/name': 'shipit-ai',
      'app.kubernetes.io/instance': 'shipit',
      'app.kubernetes.io/component': 'api-server',
      'app.kubernetes.io/managed-by': 'Helm',
      'helm.sh/chart': 'shipit-ai-0.1.0',
    },
    annotations: { 'shipit.ai/github-repo': 'Ship-It-Ops/ShipIt-AI' },
  },
  spec: {
    replicas: 2,
    selector: { matchLabels: { 'app.kubernetes.io/component': 'api-server' } },
    template: {
      spec: {
        containers: [
          {
            name: 'api-server',
            image: 'us-central1-docker.pkg.dev/ship-it-ai-portal/shipit-ai/api-server:sha-97189de',
          },
        ],
      },
    },
  },
  status: {
    replicas: 2,
    readyReplicas: 2,
    conditions: [
      { type: 'Available', status: 'True' },
      { type: 'Progressing', status: 'True' },
    ],
  },
};

export const apiServerPods: PodSummary = {
  readyPods: 2,
  restarts: 3,
  imageDigests: {
    'api-server': 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
};

export const redisStatefulSet: V1StatefulSet = {
  apiVersion: 'apps/v1',
  kind: 'StatefulSet',
  metadata: {
    name: 'redis',
    namespace: 'shipit',
    labels: {
      'app.kubernetes.io/name': 'shipit-ai',
      'app.kubernetes.io/instance': 'shipit',
      'app.kubernetes.io/component': 'redis',
    },
  },
  spec: {
    replicas: 1,
    serviceName: 'redis',
    selector: { matchLabels: { 'app.kubernetes.io/component': 'redis' } },
    template: { spec: { containers: [{ name: 'redis', image: 'redis:7-alpine' }] } },
  },
  status: { replicas: 1, readyReplicas: 1 },
};

export const nodeExporterDaemonSet: V1DaemonSet = {
  apiVersion: 'apps/v1',
  kind: 'DaemonSet',
  metadata: { name: 'node-exporter', namespace: 'monitoring', labels: {} },
  spec: {
    selector: { matchLabels: { app: 'node-exporter' } },
    template: {
      spec: {
        containers: [{ name: 'exporter', image: 'quay.io/prometheus/node-exporter:v1.8.1' }],
      },
    },
  },
  status: {
    currentNumberScheduled: 3,
    desiredNumberScheduled: 3,
    numberMisscheduled: 0,
    numberReady: 2,
  },
};

export const backupCronJob: V1CronJob = {
  apiVersion: 'batch/v1',
  kind: 'CronJob',
  metadata: {
    name: 'neo4j-backup',
    namespace: 'shipit',
    labels: { 'app.kubernetes.io/name': 'shipit-ai' },
  },
  spec: {
    schedule: '0 3 * * *',
    suspend: true,
    jobTemplate: {
      spec: {
        template: {
          spec: { containers: [{ name: 'backup', image: 'ghcr.io/acme/backup:1.2.3' }] },
        },
      },
    },
  },
};

export const demoContext: NormalizerContext = {
  cluster: CLUSTER,
  mapping: {
    service: { nameFrom: ['part-of', 'name', 'workload'], includeComponent: false },
    environment: {
      label: 'environment',
      namespaceRules: [
        { pattern: '^(prod|production)', environment: 'production' },
        { pattern: '^(stag|staging)', environment: 'staging' },
        { pattern: '^(dev|development)', environment: 'development' },
      ],
      default: null,
    },
    ownership: { teamLabel: 'team' },
    repoLink: { annotation: 'shipit.ai/github-repo', githubOrg: null, nameMatch: true },
  },
  githubOrg: 'Ship-It-Ops',
  knownRepositories: ['ShipIt-AI'],
  knownTeams: ['platform-team'],
  now: NOW,
};

export function rawWorkload(
  kind: WorkloadKind,
  object: WorkloadObject,
  pods: PodSummary = EMPTY_POD_SUMMARY,
  namespace: NamespaceRef = demoNamespace,
): RawWorkload {
  return { __shipit: 'workload', kind, object, namespace, pods };
}
```

- [ ] **Step 2: Write the failing tests**

Create `packages/connectors/kubernetes/src/__tests__/normalizers.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeCluster } from '../normalizers/cluster.js';
import { normalizeNamespace } from '../normalizers/namespace.js';
import { normalizeWorkload, deriveServiceName } from '../normalizers/workload.js';
import {
  apiServerDeployment,
  apiServerPods,
  backupCronJob,
  demoContext,
  demoNamespace,
  nodeExporterDaemonSet,
  rawWorkload,
  redisStatefulSet,
  CLUSTER,
  NOW,
} from './fixtures/demo-cluster.js';

const edge = (out: { edges: Array<{ type: string; from: string; to: string }> }, type: string) =>
  out.edges.filter((e) => e.type === type);

describe('normalizeCluster', () => {
  it('emits one Cluster node with kubernetes provenance', () => {
    const out = normalizeCluster(
      {
        __shipit: 'cluster',
        name: CLUSTER,
        version: 'v1.31.2-gke.1',
        provider: 'gcp',
        region: 'us-central1',
      },
      demoContext,
    );
    expect(out.nodes).toHaveLength(1);
    const node = out.nodes[0];
    expect(node.id).toBe('shipit://cluster/default/shipit-demo');
    expect(node.label).toBe('Cluster');
    expect(node.properties).toEqual({
      name: CLUSTER,
      provider: 'gcp',
      region: 'us-central1',
      version: 'v1.31.2-gke.1',
    });
    expect(node._source_system).toBe('kubernetes');
    expect(node._source_org).toBe('kubernetes/shipit-demo');
    expect(node._source_id).toBe('k8s://shipit-demo');
    expect(node._last_synced).toBe(NOW);
    expect(String(node._event_version)).toMatch(/^ch_/);
    expect(node._claims.map((c) => c.property_key).sort()).toEqual([
      'name',
      'provider',
      'region',
      'version',
    ]);
    expect(node._claims.every((c) => c.source === 'kubernetes' && c.confidence === 0.85)).toBe(
      true,
    );
    expect(out.edges).toEqual([]);
  });

  it('omits provider/region/version when unknown instead of fabricating them', () => {
    const out = normalizeCluster({ __shipit: 'cluster', name: CLUSTER }, demoContext);
    expect(out.nodes[0].properties).toEqual({ name: CLUSTER });
  });
});

describe('normalizeNamespace', () => {
  it('emits the Namespace node and its PART_OF edge to the cluster', () => {
    const out = normalizeNamespace(
      {
        __shipit: 'namespace',
        object: { metadata: { name: 'shipit', labels: { environment: 'production', team: 'x' } } },
      },
      demoContext,
    );
    expect(out.nodes[0].id).toBe('shipit://namespace/default/shipit-demo/shipit');
    expect(out.nodes[0].properties).toEqual({
      name: 'shipit',
      cluster: CLUSTER,
      labels: ['environment=production', 'team=x'],
    });
    expect(edge(out, 'PART_OF')).toEqual([
      expect.objectContaining({
        from: 'shipit://namespace/default/shipit-demo/shipit',
        to: 'shipit://cluster/default/shipit-demo',
        _confidence: 1.0,
      }),
    ]);
  });
});

describe('normalizeWorkload — Deployment with annotation (demo api-server)', () => {
  const out = normalizeWorkload(
    rawWorkload('Deployment', apiServerDeployment, apiServerPods),
    demoContext,
  );
  const byLabel = (label: string) => out.nodes.filter((n) => n.label === label);
  const deploymentId = 'shipit://deployment/default/shipit-demo/shipit/deployment/api-server';
  const repoId = 'shipit://repository/default/Ship-It-Ops/ShipIt-AI';
  const serviceId = 'shipit://logical-service/default/shipit-ai';

  it('emits the Deployment node with the spec property set', () => {
    const [dep] = byLabel('Deployment');
    expect(dep.id).toBe(deploymentId);
    expect(dep.properties).toEqual({
      name: 'api-server',
      namespace: 'shipit',
      cluster: CLUSTER,
      kind: 'Deployment',
      environment: 'production',
      image: 'us-central1-docker.pkg.dev/ship-it-ai-portal/shipit-ai/api-server:sha-97189de',
      images: ['us-central1-docker.pkg.dev/ship-it-ai-portal/shipit-ai/api-server:sha-97189de'],
      replicas: 2,
      ready_replicas: 2,
      status: 'Available',
      created_at: '2026-06-10T08:00:00.000Z',
      restarts: 3,
      labels: [
        'app.kubernetes.io/component=api-server',
        'app.kubernetes.io/instance=shipit',
        'app.kubernetes.io/managed-by=Helm',
        'app.kubernetes.io/name=shipit-ai',
      ],
    });
    expect(dep._source_id).toBe('k8s://shipit-demo/shipit/deployment/api-server');
    expect(dep._claims.find((c) => c.property_key === 'status')?.confidence).toBe(0.85);
  });

  it('derives the environment from the namespace label and links RUNS_IN / RUNS_IN_ENV', () => {
    expect(byLabel('Environment')[0]).toMatchObject({
      id: 'shipit://environment/default/production',
      properties: { name: 'production', type: 'production' },
    });
    expect(edge(out, 'RUNS_IN')).toEqual([
      expect.objectContaining({
        from: deploymentId,
        to: 'shipit://namespace/default/shipit-demo/shipit',
      }),
    ]);
    expect(edge(out, 'RUNS_IN_ENV')).toEqual([
      expect.objectContaining({
        from: deploymentId,
        to: 'shipit://environment/default/production',
        _confidence: 0.95,
        properties: { derived_from: 'namespace-label' },
      }),
    ]);
  });

  it('emits a BuildArtifact keyed by the pod digest, RUNS_IMAGE and BUILT_FROM via the annotation', () => {
    const [art] = byLabel('BuildArtifact');
    expect(art.id).toBe(
      'shipit://build-artifact/default/us-central1-docker.pkg.dev/ship-it-ai-portal/shipit-ai/api-server@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    );
    expect(art.properties).toEqual({
      name: 'ship-it-ai-portal/shipit-ai/api-server',
      image_tag: 'sha-97189de',
      sha: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      registry: 'us-central1-docker.pkg.dev',
    });
    expect(edge(out, 'RUNS_IMAGE')).toEqual([
      expect.objectContaining({
        from: deploymentId,
        to: art.id,
        properties: { container: 'api-server' },
      }),
    ]);
    expect(edge(out, 'BUILT_FROM')).toEqual([
      expect.objectContaining({
        from: art.id,
        to: repoId,
        _confidence: 1.0,
        properties: { link_method: 'annotation' },
      }),
    ]);
  });

  it('emits the LogicalService with 0.7 claims, DEPLOYED_AS, IMPLEMENTED_BY and Team OWNS', () => {
    const [svc] = byLabel('LogicalService');
    expect(svc.id).toBe(serviceId);
    expect(svc.properties).toEqual({ name: 'shipit-ai' });
    expect(svc._claims[0]).toMatchObject({
      property_key: 'name',
      confidence: 0.7,
      source: 'kubernetes',
    });
    expect(svc._source_id).toBe('k8s://shipit-demo/service/shipit-ai');
    expect(edge(out, 'DEPLOYED_AS')).toEqual([
      expect.objectContaining({ from: serviceId, to: deploymentId, _confidence: 1.0 }),
    ]);
    expect(edge(out, 'IMPLEMENTED_BY')).toEqual([
      expect.objectContaining({
        from: serviceId,
        to: repoId,
        _confidence: 1.0,
        properties: { link_method: 'annotation' },
      }),
    ]);
    expect(edge(out, 'OWNS')).toEqual([
      expect.objectContaining({
        from: 'shipit://team/default/Ship-It-Ops/platform-team',
        to: serviceId,
        _confidence: 0.85,
        properties: { derived_from: 'namespace-label' },
      }),
    ]);
    expect(out.warnings).toEqual([]);
  });

  it('stamps every node with kubernetes provenance and the call timestamp', () => {
    for (const n of out.nodes) {
      expect(n._source_system).toBe('kubernetes');
      expect(n._source_org).toBe('kubernetes/shipit-demo');
      expect(n._last_synced).toBe(NOW);
      expect(String(n._event_version)).toMatch(/^ch_/);
    }
  });
});

describe('normalizeWorkload — other kinds and fallbacks', () => {
  it('StatefulSet without annotation links by app label (tier 3) and reports Available when ready', () => {
    const out = normalizeWorkload(rawWorkload('StatefulSet', redisStatefulSet), demoContext);
    const dep = out.nodes.find((n) => n.label === 'Deployment')!;
    expect(dep.id).toBe('shipit://deployment/default/shipit-demo/shipit/statefulset/redis');
    expect(dep.properties).toMatchObject({
      kind: 'StatefulSet',
      replicas: 1,
      ready_replicas: 1,
      status: 'Available',
      image: 'redis:7-alpine',
      restarts: 0,
    });
    expect(edge(out, 'IMPLEMENTED_BY')[0]).toMatchObject({
      to: 'shipit://repository/default/Ship-It-Ops/ShipIt-AI',
      _confidence: 0.6,
      properties: { link_method: 'app-label' },
    });
    // docker.io/library/redis has no pod digest → keyed by tag
    expect(out.nodes.find((n) => n.label === 'BuildArtifact')?.id).toBe(
      'shipit://build-artifact/default/docker.io/library/redis@7-alpine',
    );
  });

  it('DaemonSet uses desiredNumberScheduled / numberReady and derives no environment for an unmatched namespace', () => {
    const out = normalizeWorkload(
      rawWorkload('DaemonSet', nodeExporterDaemonSet, undefined, {
        name: 'monitoring',
        labels: {},
        annotations: {},
      }),
      { ...demoContext, knownRepositories: [] },
    );
    const dep = out.nodes.find((n) => n.label === 'Deployment')!;
    expect(dep.properties).toMatchObject({
      kind: 'DaemonSet',
      replicas: 3,
      ready_replicas: 2,
      status: 'Progressing',
    });
    expect(dep.properties).not.toHaveProperty('environment');
    expect(out.nodes.some((n) => n.label === 'Environment')).toBe(false);
    expect(edge(out, 'RUNS_IN_ENV')).toEqual([]);
    expect(edge(out, 'IMPLEMENTED_BY')).toEqual([]);
    // service name falls back to the workload name when no app labels exist
    expect(out.nodes.find((n) => n.label === 'LogicalService')?.id).toBe(
      'shipit://logical-service/default/node-exporter',
    );
  });

  it('CronJob has no replica counts, reads containers from the job template, and is Suspended when suspend=true', () => {
    const out = normalizeWorkload(rawWorkload('CronJob', backupCronJob), demoContext);
    const dep = out.nodes.find((n) => n.label === 'Deployment')!;
    expect(dep.properties).toMatchObject({
      kind: 'CronJob',
      status: 'Suspended',
      image: 'ghcr.io/acme/backup:1.2.3',
    });
    expect(dep.properties).not.toHaveProperty('replicas');
    expect(dep.properties).not.toHaveProperty('ready_replicas');
  });

  it('a Deployment whose Available condition is False is Degraded', () => {
    const degraded = {
      ...apiServerDeployment,
      status: {
        replicas: 2,
        readyReplicas: 0,
        conditions: [{ type: 'Available', status: 'False' }],
      },
    };
    const out = normalizeWorkload(rawWorkload('Deployment', degraded), demoContext);
    expect(out.nodes.find((n) => n.label === 'Deployment')?.properties.status).toBe('Degraded');
  });

  it('a malformed annotation surfaces as a warning and the name tiers still link', () => {
    const bad = {
      ...apiServerDeployment,
      metadata: {
        ...apiServerDeployment.metadata,
        annotations: { 'shipit.ai/github-repo': 'nope' },
      },
    };
    const out = normalizeWorkload(rawWorkload('Deployment', bad), demoContext);
    expect(out.warnings).toEqual(['ignored shipit.ai/github-repo="nope": expected <org>/<repo>']);
    expect(edge(out, 'IMPLEMENTED_BY')[0]).toMatchObject({
      _confidence: 0.6,
      properties: { link_method: 'app-label' },
    });
  });

  it('skips a workload without metadata.name', () => {
    const out = normalizeWorkload(
      rawWorkload('Deployment', { ...apiServerDeployment, metadata: {} }),
      demoContext,
    );
    expect(out.nodes).toEqual([]);
    expect(out.warnings).toEqual(['Deployment without metadata.name skipped']);
  });
});

describe('deriveServiceName', () => {
  const svc = {
    nameFrom: ['part-of', 'name', 'workload'] as Array<'part-of' | 'name' | 'workload'>,
    includeComponent: false,
  };
  it('follows nameFrom order and optionally appends the component', () => {
    expect(
      deriveServiceName(
        'api-server',
        { 'app.kubernetes.io/part-of': 'payments', 'app.kubernetes.io/name': 'api' },
        svc,
      ),
    ).toBe('payments');
    expect(
      deriveServiceName(
        'api-server',
        { 'app.kubernetes.io/name': 'shipit-ai', 'app.kubernetes.io/component': 'api-server' },
        { ...svc, includeComponent: true },
      ),
    ).toBe('shipit-ai/api-server');
    expect(deriveServiceName('api-server', {}, svc)).toBe('api-server');
    expect(
      deriveServiceName(
        'api-server',
        { 'app.kubernetes.io/name': 'x' },
        { ...svc, nameFrom: ['workload'] },
      ),
    ).toBe('api-server');
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd packages/connectors/kubernetes && npx vitest run src/__tests__/normalizers.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: `normalizers/claims.ts`**

```ts
import type { CanonicalEdge, CanonicalNode, PropertyClaim } from '@shipit-ai/shared';
import { deriveContentVersion } from '@shipit-ai/shared';
import type { NormalizerContext } from '../types.js';

export const KUBERNETES_CLAIM_CONFIDENCE = 0.85;
export const LOGICAL_SERVICE_CLAIM_CONFIDENCE = 0.7;

/** Drop `undefined` values so missing source data omits the property (never fabricated). */
export function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

export function makeClaims(
  properties: Record<string, unknown>,
  sourceId: string,
  now: string,
  confidence = KUBERNETES_CLAIM_CONFIDENCE,
): PropertyClaim[] {
  return Object.entries(properties).map(([property_key, value]) => ({
    property_key,
    value,
    source: 'kubernetes',
    source_id: sourceId,
    ingested_at: now,
    confidence,
    evidence: null,
  }));
}

/** Node with kubernetes provenance; `properties` must already be compacted. */
export function makeNode(
  id: string,
  label: string,
  properties: Record<string, unknown>,
  sourceId: string,
  ctx: NormalizerContext,
  confidence = KUBERNETES_CLAIM_CONFIDENCE,
): CanonicalNode {
  return {
    id,
    label,
    properties,
    _claims: makeClaims(properties, sourceId, ctx.now, confidence),
    _source_system: 'kubernetes',
    _source_org: `kubernetes/${ctx.cluster}`,
    _source_id: sourceId,
    _last_synced: ctx.now,
    // Polling cannot deliver out of order; a content hash makes re-syncs of
    // unchanged content dedup and any change reach the writer (Cut B semantics).
    _event_version: deriveContentVersion(properties),
  };
}

export function makeEdge(
  type: string,
  from: string,
  to: string,
  confidence: number,
  now: string,
  properties?: Record<string, unknown>,
): CanonicalEdge {
  return {
    type,
    from,
    to,
    ...(properties ? { properties } : {}),
    _source: 'kubernetes',
    _confidence: confidence,
    _ingested_at: now,
  };
}
```

- [ ] **Step 5: `normalizers/cluster.ts` and `normalizers/namespace.ts`**

```ts
// cluster.ts
import type { NormalizeOutput, NormalizerContext, RawCluster } from '../types.js';
import { compact, makeNode } from './claims.js';
import { ids, keys } from './identity.js';

export function normalizeCluster(raw: RawCluster, ctx: NormalizerContext): NormalizeOutput {
  const properties = compact({
    name: raw.name,
    provider: raw.provider,
    region: raw.region,
    version: raw.version,
  });
  const node = makeNode(ids.cluster(raw.name), 'Cluster', properties, keys.cluster(raw.name), ctx);
  return { nodes: [node], edges: [], warnings: [] };
}
```

```ts
// namespace.ts
import type { NormalizeOutput, NormalizerContext, RawNamespace } from '../types.js';
import { makeEdge, makeNode } from './claims.js';
import { ids, keys } from './identity.js';

export function labelsToList(labels: Record<string, string> | undefined): string[] {
  return Object.entries(labels ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .sort();
}

export function normalizeNamespace(raw: RawNamespace, ctx: NormalizerContext): NormalizeOutput {
  const name = raw.object.metadata?.name;
  if (!name) return { nodes: [], edges: [], warnings: ['namespace without metadata.name skipped'] };
  const properties = {
    name,
    cluster: ctx.cluster,
    labels: labelsToList(raw.object.metadata?.labels),
  };
  const node = makeNode(
    ids.namespace(ctx.cluster, name),
    'Namespace',
    properties,
    keys.namespace(ctx.cluster, name),
    ctx,
  );
  const partOf = makeEdge('PART_OF', node.id, ids.cluster(ctx.cluster), 1.0, ctx.now);
  return { nodes: [node], edges: [partOf], warnings: [] };
}
```

- [ ] **Step 6: `normalizers/workload.ts`**

```ts
import type { V1CronJob, V1DaemonSet, V1Deployment, V1StatefulSet } from '@kubernetes/client-node';
import type { CanonicalEdge, CanonicalNode, KubernetesMappingConfig } from '@shipit-ai/shared';
import type { NormalizeOutput, NormalizerContext, RawWorkload } from '../types.js';
import { compact, LOGICAL_SERVICE_CLAIM_CONFIDENCE, makeEdge, makeNode } from './claims.js';
import { deriveEnvironment, environmentType } from './environment.js';
import { ids, keys, parseImageRef, type ParsedImage } from './identity.js';
import { resolveRepositoryLink, resolveTeamLink } from './linking.js';

interface WorkloadShape {
  containers: Array<{ name: string; image: string }>;
  replicas?: number;
  readyReplicas?: number;
  status: 'Available' | 'Progressing' | 'Degraded' | 'Suspended' | 'Unknown';
}

function containersOf(
  spec: { containers?: Array<{ name: string; image?: string }> } | undefined,
): Array<{ name: string; image: string }> {
  return (spec?.containers ?? [])
    .filter(
      (c): c is { name: string; image: string } =>
        typeof c.image === 'string' && c.image.length > 0,
    )
    .map((c) => ({ name: c.name, image: c.image }));
}

function replicaStatus(desired: number, ready: number): WorkloadShape['status'] {
  if (desired === 0) return 'Unknown';
  if (ready >= desired) return 'Available';
  if (ready > 0) return 'Progressing';
  return 'Degraded';
}

/** Per-kind extraction of containers, replica counts and a normalized status. */
export function workloadShape(raw: RawWorkload): WorkloadShape {
  switch (raw.kind) {
    case 'Deployment': {
      const o = raw.object as V1Deployment;
      const conditions = o.status?.conditions ?? [];
      const available = conditions.find((c) => c.type === 'Available');
      const progressing = conditions.find((c) => c.type === 'Progressing');
      const status: WorkloadShape['status'] =
        available?.status === 'True'
          ? 'Available'
          : progressing?.status === 'True'
            ? 'Progressing'
            : available?.status === 'False'
              ? 'Degraded'
              : 'Unknown';
      return {
        containers: containersOf(o.spec?.template?.spec),
        replicas: o.spec?.replicas ?? 1,
        readyReplicas: o.status?.readyReplicas ?? 0,
        status,
      };
    }
    case 'StatefulSet': {
      const o = raw.object as V1StatefulSet;
      const replicas = o.spec?.replicas ?? 1;
      const ready = o.status?.readyReplicas ?? 0;
      return {
        containers: containersOf(o.spec?.template?.spec),
        replicas,
        readyReplicas: ready,
        status: replicaStatus(replicas, ready),
      };
    }
    case 'DaemonSet': {
      const o = raw.object as V1DaemonSet;
      const desired = o.status?.desiredNumberScheduled ?? 0;
      const ready = o.status?.numberReady ?? 0;
      return {
        containers: containersOf(o.spec?.template?.spec),
        replicas: desired,
        readyReplicas: ready,
        status: replicaStatus(desired, ready),
      };
    }
    case 'CronJob': {
      const o = raw.object as V1CronJob;
      return {
        containers: containersOf(o.spec?.jobTemplate?.spec?.template?.spec),
        status: o.spec?.suspend ? 'Suspended' : 'Available',
      };
    }
  }
}

/** Spec §Service identity: first present of part-of / name / workload name, optionally + component. */
export function deriveServiceName(
  workloadName: string,
  labels: Record<string, string>,
  mapping: KubernetesMappingConfig['service'],
): string {
  let base: string | undefined;
  for (const source of mapping.nameFrom) {
    const candidate =
      source === 'part-of'
        ? labels['app.kubernetes.io/part-of']
        : source === 'name'
          ? labels['app.kubernetes.io/name']
          : workloadName;
    if (candidate && candidate.trim()) {
      base = candidate.trim();
      break;
    }
  }
  base ??= workloadName;
  const component = labels['app.kubernetes.io/component'];
  return mapping.includeComponent && component ? `${base}/${component}` : base;
}

function selectedLabels(
  labels: Record<string, string>,
  mapping: KubernetesMappingConfig,
): string[] {
  const keep = new Set([mapping.environment.label, 'env', mapping.ownership.teamLabel]);
  return Object.entries(labels)
    .filter(([k]) => k.startsWith('app.kubernetes.io/') || keep.has(k))
    .map(([k, v]) => `${k}=${v}`)
    .sort();
}

function toIso(value: unknown): string | undefined {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string' && value) return value;
  return undefined;
}

export function normalizeWorkload(raw: RawWorkload, ctx: NormalizerContext): NormalizeOutput {
  const warnings: string[] = [];
  const meta = raw.object.metadata ?? {};
  const name = meta.name;
  if (!name)
    return { nodes: [], edges: [], warnings: [`${raw.kind} without metadata.name skipped`] };
  const ns = raw.namespace.name;
  const labels = meta.labels ?? {};
  const annotations = meta.annotations ?? {};
  const shape = workloadShape(raw);

  const images: Array<{ container: string; ref: string; image: ParsedImage }> =
    shape.containers.map((c) => ({
      container: c.name,
      ref: c.image,
      image: parseImageRef(c.image),
    }));
  for (const i of images) {
    const digest = raw.pods.imageDigests[i.container];
    if (digest) i.image.digest = digest;
  }

  const env = deriveEnvironment({
    workloadLabels: labels,
    namespaceLabels: raw.namespace.labels,
    namespaceName: ns,
    mapping: ctx.mapping.environment,
  });

  const deploymentId = ids.deployment(ctx.cluster, ns, raw.kind, name);
  const sourceId = keys.workload(ctx.cluster, ns, raw.kind, name);
  const properties = compact({
    name,
    namespace: ns,
    cluster: ctx.cluster,
    kind: raw.kind,
    environment: env?.environment,
    image: images[0]?.ref,
    images: images.map((i) => i.ref),
    replicas: shape.replicas,
    ready_replicas: shape.readyReplicas,
    status: shape.status,
    created_at: toIso(meta.creationTimestamp),
    restarts: raw.pods.restarts,
    labels: selectedLabels(labels, ctx.mapping),
  });

  const nodes: CanonicalNode[] = [makeNode(deploymentId, 'Deployment', properties, sourceId, ctx)];
  const edges: CanonicalEdge[] = [
    makeEdge('RUNS_IN', deploymentId, ids.namespace(ctx.cluster, ns), 1.0, ctx.now),
  ];

  if (env) {
    const envId = ids.environment(env.environment);
    const envProps = compact({ name: env.environment, type: environmentType(env.environment) });
    nodes.push(
      makeNode(envId, 'Environment', envProps, keys.environment(ctx.cluster, env.environment), ctx),
    );
    edges.push(
      makeEdge('RUNS_IN_ENV', deploymentId, envId, env.confidence, ctx.now, {
        derived_from: env.derivedFrom,
      }),
    );
  }

  const repo = resolveRepositoryLink({
    annotations,
    namespaceAnnotations: raw.namespace.annotations,
    labels,
    images: images.map((i) => i.image),
    mapping: ctx.mapping.repoLink,
    knownRepositories: ctx.knownRepositories,
    githubOrg: ctx.githubOrg,
  });
  warnings.push(...repo.warnings);
  const repoId = repo.link ? ids.repository(repo.link.org, repo.link.repo) : null;

  const seenArtifacts = new Set<string>();
  for (const i of images) {
    const artifactId = ids.buildArtifact(i.image);
    if (!seenArtifacts.has(artifactId)) {
      seenArtifacts.add(artifactId);
      const artifactProps = compact({
        name: i.image.repository,
        image_tag: i.image.tag,
        sha: i.image.digest,
        registry: i.image.registry,
      });
      nodes.push(
        makeNode(artifactId, 'BuildArtifact', artifactProps, keys.image(ctx.cluster, i.image), ctx),
      );
      if (repoId && repo.link) {
        edges.push(
          makeEdge('BUILT_FROM', artifactId, repoId, repo.link.confidence, ctx.now, {
            link_method: repo.link.linkMethod,
          }),
        );
      }
    }
    edges.push(
      makeEdge('RUNS_IMAGE', deploymentId, artifactId, 1.0, ctx.now, { container: i.container }),
    );
  }

  const serviceName = deriveServiceName(name, labels, ctx.mapping.service);
  const serviceId = ids.logicalService(serviceName);
  const serviceProps = { name: serviceName };
  nodes.push(
    makeNode(
      serviceId,
      'LogicalService',
      serviceProps,
      keys.service(ctx.cluster, serviceName),
      ctx,
      LOGICAL_SERVICE_CLAIM_CONFIDENCE,
    ),
  );
  edges.push(makeEdge('DEPLOYED_AS', serviceId, deploymentId, 1.0, ctx.now));
  if (repoId && repo.link) {
    edges.push(
      makeEdge('IMPLEMENTED_BY', serviceId, repoId, repo.link.confidence, ctx.now, {
        link_method: repo.link.linkMethod,
      }),
    );
  }

  const team = resolveTeamLink({
    labels,
    namespaceLabels: raw.namespace.labels,
    teamLabel: ctx.mapping.ownership.teamLabel,
    knownTeams: ctx.knownTeams,
    githubOrg: ctx.githubOrg,
  });
  warnings.push(...team.warnings);
  if (team.link) {
    edges.push(
      makeEdge(
        'OWNS',
        ids.team(team.link.org, team.link.slug),
        serviceId,
        team.link.confidence,
        ctx.now,
        { derived_from: team.link.derivedFrom },
      ),
    );
  }

  return { nodes, edges, warnings };
}
```

Note on `serviceProps`: the LogicalService `name` claim keeps the operator-facing name (`shipit-ai` here; for `Payments API` it would be `Payments API` while the id uses `payments-api`).

- [ ] **Step 7: Run the tests + typecheck**

Run: `cd packages/connectors/kubernetes && npx vitest run && npx tsc --noEmit`
Expected: PASS, clean. If `tsc` complains about the fixture's `V1Deployment` shape (e.g. `apiVersion`/`kind` typed as optional strings), keep the fixture object literals and add `satisfies V1Deployment` where needed — never loosen the normalizer types.

- [ ] **Step 8: Commit**

```bash
git add packages/connectors/kubernetes/src
git commit -m "connector-kubernetes: cluster, namespace and workload normalizers with demo-cluster fixtures"
```

---

### Task 8: Connector package — access modes, kubeconfig validation, error classification

Implements spec §Access modes, §Error handling (codes), §Safety (plugin/TLS rejection).

**Files:**

- Create: `packages/connectors/kubernetes/src/auth.ts`
- Test: `packages/connectors/kubernetes/src/__tests__/auth.test.ts`

**Interfaces:**

- Produces: `type KubernetesErrorCode`, `class KubernetesError extends Error { code; status? }`, `type KubernetesAccessCredentials` (three modes), `parseCredentials(raw: Record<string,string>)`, `validateKubeconfigText(text, context?)`, `buildKubeConfig(creds, probe?)`, `classifyError(err): KubernetesError`, `interface KubeClients`, `type ClientFactory`, `defaultClientFactory`, `SERVICE_ACCOUNT_TOKEN_PATH`.
- Consumed by: Task 9 (connector/fetchers), Task 11 (probe + credentials route).

- [ ] **Step 1: Write the failing tests**

Create `packages/connectors/kubernetes/src/__tests__/auth.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ApiException } from '@kubernetes/client-node';
import {
  KubernetesError,
  buildKubeConfig,
  classifyError,
  parseCredentials,
  validateKubeconfigText,
  SERVICE_ACCOUNT_TOKEN_PATH,
} from '../auth.js';

const tokenKubeconfig = (extraContexts = '') => `
apiVersion: v1
kind: Config
clusters:
- name: demo
  cluster:
    server: https://10.0.0.1:6443
    certificate-authority-data: ${Buffer.from('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n').toString('base64')}
users:
- name: reader
  user:
    token: abc123
contexts:
- name: demo
  context:
    cluster: demo
    user: reader
${extraContexts}
current-context: demo
`;

const execKubeconfig = `
apiVersion: v1
kind: Config
clusters:
- name: gke
  cluster:
    server: https://34.1.2.3
    certificate-authority-data: ${Buffer.from('x').toString('base64')}
users:
- name: gke
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: gke-gcloud-auth-plugin
contexts:
- name: gke
  context: { cluster: gke, user: gke }
current-context: gke
`;

describe('parseCredentials', () => {
  it('maps the three modes and rejects incomplete or unknown ones', () => {
    expect(parseCredentials({ mode: 'in-cluster' })).toEqual({ mode: 'in-cluster' });
    expect(parseCredentials({ mode: 'kubeconfig', kubeconfig: 'x', context: '' })).toEqual({
      mode: 'kubeconfig',
      kubeconfig: 'x',
      context: undefined,
    });
    expect(
      parseCredentials({ mode: 'token', server: 'https://h', token: 't', caData: 'Y2E=' }),
    ).toEqual({
      mode: 'token',
      server: 'https://h',
      token: 't',
      caData: 'Y2E=',
    });
    expect(() => parseCredentials({ mode: 'kubeconfig' })).toThrow(KubernetesError);
    expect(() => parseCredentials({ mode: 'token', server: 'https://h' })).toThrow(/token/);
    expect(() => parseCredentials({})).toThrow(/unknown access mode/);
  });
});

describe('validateKubeconfigText', () => {
  it('accepts a single-context token kubeconfig', () => {
    expect(validateKubeconfigText(tokenKubeconfig())).toEqual({
      ok: true,
      contexts: ['demo'],
      currentContext: 'demo',
    });
  });

  it('requires an explicit context when several exist, and accepts it when given', () => {
    const two = tokenKubeconfig(`- name: other
  context:
    cluster: demo
    user: reader`);
    expect(validateKubeconfigText(two)).toMatchObject({ ok: false, code: 'KUBECONFIG_INVALID' });
    expect(validateKubeconfigText(two, 'other')).toMatchObject({
      ok: true,
      currentContext: 'other',
    });
    expect(validateKubeconfigText(two, 'missing')).toMatchObject({
      ok: false,
      code: 'KUBECONFIG_INVALID',
    });
  });

  it('rejects exec/auth-provider users with UNSUPPORTED_AUTH_PLUGIN', () => {
    expect(validateKubeconfigText(execKubeconfig)).toMatchObject({
      ok: false,
      code: 'UNSUPPORTED_AUTH_PLUGIN',
    });
  });

  it('rejects insecure-skip-tls-verify, file references and unparseable text', () => {
    const insecure = tokenKubeconfig().replace(
      'certificate-authority-data',
      'insecure-skip-tls-verify: true\n    certificate-authority-data',
    );
    expect(validateKubeconfigText(insecure)).toMatchObject({
      ok: false,
      code: 'KUBECONFIG_INVALID',
    });
    const fileRef = tokenKubeconfig().replace(
      /certificate-authority-data: .*/,
      'certificate-authority: /etc/ca.crt',
    );
    expect(validateKubeconfigText(fileRef)).toMatchObject({
      ok: false,
      code: 'KUBECONFIG_INVALID',
    });
    expect(validateKubeconfigText('not: [valid')).toMatchObject({
      ok: false,
      code: 'KUBECONFIG_INVALID',
    });
  });
});

describe('buildKubeConfig', () => {
  it('in-cluster fails fast without a ServiceAccount token', () => {
    expect(() =>
      buildKubeConfig({ mode: 'in-cluster' }, { env: {}, fileExists: () => false }),
    ).toThrow(/IN_CLUSTER_UNAVAILABLE/);
    expect(() =>
      buildKubeConfig(
        { mode: 'in-cluster' },
        { env: { KUBERNETES_SERVICE_HOST: '10.0.0.1' }, fileExists: () => false },
      ),
    ).toThrow(/IN_CLUSTER_UNAVAILABLE/);
  });

  it('in-cluster loads the ServiceAccount config when the token file exists', () => {
    const kc = buildKubeConfig(
      { mode: 'in-cluster' },
      {
        env: { KUBERNETES_SERVICE_HOST: '10.0.0.1', KUBERNETES_SERVICE_PORT: '443' },
        fileExists: (p) => p === SERVICE_ACCOUNT_TOKEN_PATH,
      },
    );
    expect(kc.getCurrentCluster()?.server).toBe('https://10.0.0.1:443');
  });

  it('token mode builds a single-context config with TLS verification on', () => {
    const kc = buildKubeConfig({
      mode: 'token',
      server: 'https://h:6443',
      token: 't',
      caData: 'Y2E=',
    });
    expect(kc.getCurrentCluster()).toMatchObject({
      server: 'https://h:6443',
      caData: 'Y2E=',
      skipTLSVerify: false,
    });
    expect(kc.getCurrentUser()?.token).toBe('t');
  });

  it('kubeconfig mode validates then selects the context', () => {
    const kc = buildKubeConfig({ mode: 'kubeconfig', kubeconfig: tokenKubeconfig() });
    expect(kc.getCurrentContext()).toBe('demo');
    expect(() => buildKubeConfig({ mode: 'kubeconfig', kubeconfig: execKubeconfig })).toThrow(
      /UNSUPPORTED_AUTH_PLUGIN/,
    );
  });
});

describe('classifyError', () => {
  it('maps API status codes, network errors, TLS errors and timeouts', () => {
    expect(classifyError(new ApiException(401, 'Unauthorized', {}, {}))).toMatchObject({
      code: 'UNAUTHORIZED',
      status: 401,
    });
    expect(classifyError(new ApiException(403, 'deployments is forbidden', {}, {}))).toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
    expect(classifyError(new ApiException(500, 'boom', {}, {}))).toMatchObject({
      code: 'API_ERROR',
      status: 500,
    });
    expect(
      classifyError(
        Object.assign(new TypeError('fetch failed'), {
          cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED' },
        }),
      ),
    ).toMatchObject({ code: 'API_UNREACHABLE' });
    expect(
      classifyError(
        Object.assign(new Error('self signed'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
      ),
    ).toMatchObject({ code: 'TLS_ERROR' });
    expect(
      classifyError(new KubernetesError('TIMEOUT', 'list pods exceeded 30000 ms')),
    ).toMatchObject({ code: 'TIMEOUT' });
    expect(classifyError(new Error('weird'))).toMatchObject({ code: 'API_ERROR' });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/connectors/kubernetes && npx vitest run src/__tests__/auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `auth.ts`**

```ts
import { existsSync } from 'node:fs';
import {
  ApiException,
  AppsV1Api,
  BatchV1Api,
  CoreV1Api,
  KubeConfig,
  VersionApi,
} from '@kubernetes/client-node';

export type KubernetesErrorCode =
  | 'IN_CLUSTER_UNAVAILABLE'
  | 'UNSUPPORTED_AUTH_PLUGIN'
  | 'KUBECONFIG_INVALID'
  | 'API_UNREACHABLE'
  | 'TLS_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NAMESPACE_SCOPE_EMPTY'
  | 'TIMEOUT'
  | 'API_ERROR';

/** Structured connector error. `message` always starts with the code so it is
 *  actionable in run history; `status` lets the SDK harness sniff 401/403. */
export class KubernetesError extends Error {
  readonly code: KubernetesErrorCode;
  readonly status?: number;
  constructor(code: KubernetesErrorCode, message: string, status?: number) {
    super(`${code}: ${message}`);
    this.name = 'KubernetesError';
    this.code = code;
    this.status = status;
  }
}

export type KubernetesAccessCredentials =
  | { mode: 'in-cluster' }
  | { mode: 'kubeconfig'; kubeconfig: string; context?: string }
  | { mode: 'token'; server: string; token: string; caData?: string }; // caData: base64 PEM

/** `ConnectorConfig.credentials` → typed credentials (the factory fills the map, Task 11). */
export function parseCredentials(raw: Record<string, string>): KubernetesAccessCredentials {
  switch (raw.mode) {
    case 'in-cluster':
      return { mode: 'in-cluster' };
    case 'kubeconfig':
      if (!raw.kubeconfig) {
        throw new KubernetesError(
          'KUBECONFIG_INVALID',
          'credentials.kubeconfig is required for mode kubeconfig',
        );
      }
      return { mode: 'kubeconfig', kubeconfig: raw.kubeconfig, context: raw.context || undefined };
    case 'token':
      if (!raw.server || !raw.token) {
        throw new KubernetesError(
          'KUBECONFIG_INVALID',
          'credentials.server and credentials.token are required for mode token',
        );
      }
      return {
        mode: 'token',
        server: raw.server,
        token: raw.token,
        caData: raw.caData || undefined,
      };
    default:
      throw new KubernetesError('KUBECONFIG_INVALID', `unknown access mode "${raw.mode ?? ''}"`);
  }
}

export const SERVICE_ACCOUNT_TOKEN_PATH = '/var/run/secrets/kubernetes.io/serviceaccount/token';

/** Injection seam so tests can simulate a pod without touching the real filesystem. */
export interface InClusterProbe {
  env: NodeJS.ProcessEnv;
  fileExists: (path: string) => boolean;
}
const defaultProbe: InClusterProbe = { env: process.env, fileExists: existsSync };

export type KubeconfigValidation =
  | { ok: true; contexts: string[]; currentContext: string }
  | { ok: false; code: 'KUBECONFIG_INVALID' | 'UNSUPPORTED_AUTH_PLUGIN'; message: string };

/**
 * Spec §Access modes: exactly one context (or an explicit one); no exec /
 * auth-provider plugins (the binary is not in the pod); no file references
 * (nothing else is mounted); no insecure-skip-tls-verify.
 */
export function validateKubeconfigText(text: string, context?: string): KubeconfigValidation {
  const kc = new KubeConfig();
  try {
    kc.loadFromString(text);
  } catch (err) {
    return {
      ok: false,
      code: 'KUBECONFIG_INVALID',
      message: `kubeconfig does not parse: ${(err as Error).message}`,
    };
  }
  const contexts = kc.getContexts().map((c) => c.name);
  if (context) {
    if (!contexts.includes(context)) {
      return {
        ok: false,
        code: 'KUBECONFIG_INVALID',
        message: `context "${context}" not found (have: ${contexts.join(', ') || 'none'})`,
      };
    }
    kc.setCurrentContext(context);
  } else if (contexts.length !== 1) {
    return {
      ok: false,
      code: 'KUBECONFIG_INVALID',
      message:
        contexts.length === 0
          ? 'kubeconfig has no contexts'
          : `kubeconfig has ${contexts.length} contexts; pass "context" to pick one`,
    };
  } else if (!kc.getCurrentContext()) {
    kc.setCurrentContext(contexts[0]);
  }
  const user = kc.getCurrentUser();
  const cluster = kc.getCurrentCluster();
  if (!cluster?.server) {
    return {
      ok: false,
      code: 'KUBECONFIG_INVALID',
      message: 'current context has no cluster.server',
    };
  }
  if (cluster.skipTLSVerify) {
    return {
      ok: false,
      code: 'KUBECONFIG_INVALID',
      message: 'insecure-skip-tls-verify is not allowed; supply certificate-authority-data',
    };
  }
  if (cluster.caFile || user?.certFile || user?.keyFile) {
    return {
      ok: false,
      code: 'KUBECONFIG_INVALID',
      message:
        'file references are not allowed; inline certificate-authority-data / client-certificate-data / client-key-data',
    };
  }
  if (user?.exec || user?.authProvider) {
    return {
      ok: false,
      code: 'UNSUPPORTED_AUTH_PLUGIN',
      message:
        'kubeconfig user relies on an exec/auth-provider plugin, which cannot run inside ShipIt; paste a ServiceAccount token instead',
    };
  }
  if (!user || !(user.token || user.certData || user.keyData || user.username)) {
    return {
      ok: false,
      code: 'KUBECONFIG_INVALID',
      message: 'kubeconfig user carries no token, client certificate or basic-auth credentials',
    };
  }
  return { ok: true, contexts, currentContext: kc.getCurrentContext() };
}

export function buildKubeConfig(
  creds: KubernetesAccessCredentials,
  probe: InClusterProbe = defaultProbe,
): KubeConfig {
  const kc = new KubeConfig();
  switch (creds.mode) {
    case 'in-cluster': {
      if (!probe.env.KUBERNETES_SERVICE_HOST || !probe.fileExists(SERVICE_ACCOUNT_TOKEN_PATH)) {
        throw new KubernetesError(
          'IN_CLUSTER_UNAVAILABLE',
          'no in-cluster ServiceAccount token found (KUBERNETES_SERVICE_HOST unset or token file missing); use kubeconfig or token access instead',
        );
      }
      // client-node reads KUBERNETES_SERVICE_HOST/PORT from process.env itself;
      // the probe only decides whether we are allowed to try.
      kc.loadFromCluster();
      return kc;
    }
    case 'kubeconfig': {
      const v = validateKubeconfigText(creds.kubeconfig, creds.context);
      if (!v.ok) throw new KubernetesError(v.code, v.message);
      kc.loadFromString(creds.kubeconfig);
      kc.setCurrentContext(v.currentContext);
      return kc;
    }
    case 'token': {
      kc.loadFromOptions({
        clusters: [
          { name: 'cluster', server: creds.server, caData: creds.caData, skipTLSVerify: false },
        ],
        users: [{ name: 'user', token: creds.token }],
        contexts: [{ name: 'ctx', cluster: 'cluster', user: 'user' }],
        currentContext: 'ctx',
      });
      return kc;
    }
  }
}

/** The subset of the generated clients the connector uses; fakes implement exactly this. */
export interface KubeClients {
  core: Pick<CoreV1Api, 'listNamespace' | 'readNamespace' | 'listNode' | 'listNamespacedPod'>;
  apps: Pick<
    AppsV1Api,
    | 'listNamespacedDeployment'
    | 'listNamespacedStatefulSet'
    | 'listNamespacedDaemonSet'
    | 'listNamespacedReplicaSet'
  >;
  batch: Pick<BatchV1Api, 'listNamespacedCronJob'>;
  version: Pick<VersionApi, 'getCode'>;
}

export type ClientFactory = (kc: KubeConfig) => KubeClients;

export const defaultClientFactory: ClientFactory = (kc) => ({
  core: kc.makeApiClient(CoreV1Api),
  apps: kc.makeApiClient(AppsV1Api),
  batch: kc.makeApiClient(BatchV1Api),
  version: kc.makeApiClient(VersionApi),
});

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ECONNRESET',
  'EAI_AGAIN',
  'EPIPE',
]);
const TLS_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

/** Spec §Error handling: every failure becomes a `KubernetesError` with a stable code. */
export function classifyError(err: unknown): KubernetesError {
  if (err instanceof KubernetesError) return err;
  if (err instanceof ApiException) {
    const status = err.code;
    if (status === 401)
      return new KubernetesError(
        'UNAUTHORIZED',
        'the API server rejected the credentials (401)',
        401,
      );
    if (status === 403)
      return new KubernetesError('FORBIDDEN', `permission denied (403): ${err.message}`, 403);
    return new KubernetesError(
      'API_ERROR',
      `API server returned ${status}: ${err.message}`,
      status,
    );
  }
  const e = err as
    | {
        code?: string;
        message?: string;
        name?: string;
        cause?: { code?: string; message?: string };
      }
    | undefined;
  const code = e?.cause?.code ?? e?.code ?? '';
  const message = e?.cause?.message ?? e?.message ?? String(err);
  if (e?.name === 'TimeoutError' || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return new KubernetesError('TIMEOUT', message);
  }
  if (NETWORK_CODES.has(code)) return new KubernetesError('API_UNREACHABLE', `${code}: ${message}`);
  if (TLS_CODES.has(code) || /certificate|tls|ssl/i.test(message))
    return new KubernetesError('TLS_ERROR', message);
  return new KubernetesError('API_ERROR', message);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/connectors/kubernetes && npx vitest run src/__tests__/auth.test.ts && npx tsc --noEmit`
Expected: PASS. If `kc.getCurrentCluster()?.server` in the in-cluster test comes back `https://undefined:undefined`, client-node read `process.env` rather than the probe's env: set `process.env.KUBERNETES_SERVICE_HOST/PORT` inside that test (with `afterEach` restore) — the probe still gates the attempt.

- [ ] **Step 5: Commit**

```bash
git add packages/connectors/kubernetes/src
git commit -m "connector-kubernetes: access modes, kubeconfig validation and error classification"
```

---

### Task 9: Connector package — fetchers + `KubernetesConnector`

Implements spec §Fetch contract, §Connector package (connector.ts), §Error handling (per-kind FORBIDDEN, scope empty), and the `refetchWorkload` seam.

**Files:**

- Modify: `packages/shared/src/config/schema.ts` — add `export const KUBERNETES_DEFAULT_MAPPING: KubernetesMappingConfig = kubernetesMappingSchema.parse({});` (after the type exports) and export it from both barrels.
- Create: `packages/connectors/kubernetes/src/fetchers/common.ts`, `cluster.ts`, `namespaces.ts`, `workloads.ts`
- Create: `packages/connectors/kubernetes/src/connector.ts`
- Replace: `packages/connectors/kubernetes/src/index.ts`
- Test: `packages/connectors/kubernetes/src/__tests__/fetchers.test.ts`, `connector.test.ts`

**Interfaces:**

- Consumes: Tasks 6–8; `ShipItConnector`, `ConnectorConfig`, `FetchResult`, `AuthResult`, `DiscoveryResult`, `SyncResult` from `@shipit-ai/connector-sdk`.
- Produces: `class KubernetesConnector implements ShipItConnector` with `constructor(clientFactory = defaultClientFactory, options?: { timeoutMs?: number; inClusterProbe?: InClusterProbe })`, `getWarnings(): string[]`, `refetchWorkload(namespace, kind, name): Promise<CanonicalEntity>`; `ConnectorConfig.scope` shape `KubernetesScopeOptions { cluster: string; namespaces: { include; exclude }; kinds: WorkloadKind[]; mapping: KubernetesMappingConfig; githubOrg: string | null; knownRepositories: string[]; knownTeams: string[] }`; `ConnectorConfig.credentials` = the `parseCredentials` input map; `WorkloadFetcher`, `summarizePods`, `fetchClusterSummary`, `fetchNamespaces`, `fetchNamespaceRef`, `matchesScope`, `withTimeout`.

- [ ] **Step 1: Write the failing fetcher tests**

Create `packages/connectors/kubernetes/src/__tests__/fetchers.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { V1Pod, V1ReplicaSet } from '@kubernetes/client-node';
import { ApiException } from '@kubernetes/client-node';
import { matchesScope, withTimeout } from '../fetchers/common.js';
import { fetchClusterSummary, providerFromId } from '../fetchers/cluster.js';
import { WorkloadFetcher, summarizePods, digestFromImageId } from '../fetchers/workloads.js';
import type { KubeClients } from '../auth.js';
import { apiServerDeployment, redisStatefulSet, demoNamespace } from './fixtures/demo-cluster.js';

describe('matchesScope', () => {
  it('applies include globs then exclude globs', () => {
    expect(matchesScope('shipit', ['*'], ['kube-system'])).toBe(true);
    expect(matchesScope('kube-system', ['*'], ['kube-system'])).toBe(false);
    expect(matchesScope('team-a', ['team-*'], [])).toBe(true);
    expect(matchesScope('ops', ['team-*'], [])).toBe(false);
    expect(matchesScope('kube-public', ['*'], ['kube-*'])).toBe(false);
  });
});

describe('withTimeout', () => {
  it('rejects with a TIMEOUT KubernetesError when the promise is slow', async () => {
    await expect(withTimeout(new Promise(() => {}), 5, 'list pods')).rejects.toMatchObject({
      code: 'TIMEOUT',
    });
    await expect(withTimeout(Promise.resolve(1), 5, 'x')).resolves.toBe(1);
  });
});

describe('fetchClusterSummary', () => {
  it('reads version, provider and region, and tolerates a forbidden node list', async () => {
    const clients = {
      version: { getCode: vi.fn().mockResolvedValue({ gitVersion: 'v1.31.2-gke.1' }) },
      core: {
        listNode: vi.fn().mockResolvedValue({
          items: [
            {
              spec: { providerID: 'gce://p/us-central1-a/node1' },
              metadata: { labels: { 'topology.kubernetes.io/region': 'us-central1' } },
            },
          ],
          metadata: {},
        }),
      },
    } as unknown as KubeClients;
    expect(await fetchClusterSummary(clients, 'shipit-demo')).toEqual({
      __shipit: 'cluster',
      name: 'shipit-demo',
      version: 'v1.31.2-gke.1',
      provider: 'gcp',
      region: 'us-central1',
    });

    const denied = {
      ...clients,
      core: {
        listNode: vi.fn().mockRejectedValue(new ApiException(403, 'nodes is forbidden', {}, {})),
      },
    } as unknown as KubeClients;
    expect(await fetchClusterSummary(denied, 'shipit-demo')).toEqual({
      __shipit: 'cluster',
      name: 'shipit-demo',
      version: 'v1.31.2-gke.1',
    });
  });

  it('maps providerID schemes', () => {
    expect(providerFromId('aws:///us-east-1a/i-123')).toBe('aws');
    expect(providerFromId('azure:///subscriptions/x')).toBe('azure');
    expect(providerFromId('kind://docker/kind/kind-control-plane')).toBe('kind');
    expect(providerFromId(undefined)).toBeUndefined();
  });
});

function pod(
  name: string,
  owner: { kind: string; name: string },
  ready: boolean,
  restarts: number,
  imageID?: string,
): V1Pod {
  return {
    metadata: {
      name,
      ownerReferences: [{ apiVersion: 'apps/v1', kind: owner.kind, name: owner.name, uid: 'u' }],
    },
    status: {
      conditions: [{ type: 'Ready', status: ready ? 'True' : 'False' }],
      containerStatuses: [
        { name: 'api-server', image: 'x', imageID: imageID ?? '', ready, restartCount: restarts },
      ],
    },
  } as V1Pod;
}

describe('summarizePods', () => {
  const rs: V1ReplicaSet = {
    metadata: {
      name: 'api-server-7c9f',
      ownerReferences: [
        { apiVersion: 'apps/v1', kind: 'Deployment', name: 'api-server', uid: 'u' },
      ],
    },
  } as V1ReplicaSet;
  const digest =
    'docker-pullable://us-central1-docker.pkg.dev/p/shipit-ai/api-server@sha256:' + 'a'.repeat(64);

  it('walks Deployment → ReplicaSet → Pod and rolls up readiness, restarts and digests', () => {
    const cache = {
      replicaSets: [rs],
      pods: [
        pod('api-server-7c9f-1', { kind: 'ReplicaSet', name: 'api-server-7c9f' }, true, 2, digest),
        pod('api-server-7c9f-2', { kind: 'ReplicaSet', name: 'api-server-7c9f' }, false, 1, digest),
        pod('redis-0', { kind: 'StatefulSet', name: 'redis' }, true, 0),
      ],
    };
    expect(summarizePods('Deployment', apiServerDeployment, cache)).toEqual({
      readyPods: 1,
      restarts: 3,
      imageDigests: { 'api-server': 'sha256:' + 'a'.repeat(64) },
    });
    expect(summarizePods('StatefulSet', redisStatefulSet, cache)).toEqual({
      readyPods: 1,
      restarts: 0,
      imageDigests: {},
    });
    expect(summarizePods('CronJob', apiServerDeployment, cache)).toEqual({
      readyPods: 0,
      restarts: 0,
      imageDigests: {},
    });
  });

  it('extracts only sha256 digests from imageID', () => {
    expect(digestFromImageId(digest)).toBe('sha256:' + 'a'.repeat(64));
    expect(digestFromImageId('docker://nodigest')).toBeUndefined();
    expect(digestFromImageId(undefined)).toBeUndefined();
  });
});

describe('WorkloadFetcher', () => {
  const list = (items: unknown[], _continue?: string) => ({
    items,
    metadata: _continue ? { _continue } : {},
  });
  function clients(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      core: { listNamespacedPod: vi.fn().mockResolvedValue(list([])) },
      apps: {
        listNamespacedDeployment: vi.fn().mockResolvedValue(list([apiServerDeployment])),
        listNamespacedStatefulSet: vi.fn().mockResolvedValue(list([redisStatefulSet])),
        listNamespacedDaemonSet: vi.fn().mockResolvedValue(list([])),
        listNamespacedReplicaSet: vi.fn().mockResolvedValue(list([])),
      },
      batch: { listNamespacedCronJob: vi.fn().mockResolvedValue(list([])) },
      ...overrides,
    } as unknown as KubeClients;
  }
  const ns2 = { name: 'monitoring', labels: {}, annotations: {} };

  it('pages every kind in every namespace, threading the continue token through the cursor', async () => {
    const c = clients();
    (c.apps.listNamespacedDeployment as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(list([apiServerDeployment], 'tok'))
      .mockResolvedValueOnce(
        list([
          { ...apiServerDeployment, metadata: { ...apiServerDeployment.metadata, name: 'web-ui' } },
        ]),
      );
    const f = new WorkloadFetcher(c, [demoNamespace, ns2], ['Deployment', 'StatefulSet']);

    const seen: string[] = [];
    let cursor: string | undefined;
    let more = true;
    while (more) {
      const r = await f.fetch(cursor);
      seen.push(
        ...r.entities.map(
          (e) =>
            `${(e as { kind: string }).kind}/${(e as { namespace: { name: string } }).namespace.name}/${(e as { object: { metadata?: { name?: string } } }).object.metadata?.name}`,
        ),
      );
      cursor = r.cursor;
      more = r.has_more;
    }
    expect(seen).toEqual([
      'Deployment/shipit/api-server',
      'Deployment/shipit/web-ui',
      'StatefulSet/shipit/redis',
      'Deployment/monitoring/api-server',
      'StatefulSet/monitoring/redis',
    ]);
    expect(c.apps.listNamespacedDeployment).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ namespace: 'shipit', _continue: 'tok', limit: 500 }),
    );
    // pods + replicasets listed ONCE per namespace, not per workload
    expect(c.core.listNamespacedPod).toHaveBeenCalledTimes(2);
    expect(c.apps.listNamespacedReplicaSet).toHaveBeenCalledTimes(2);
  });

  it('a forbidden kind is skipped everywhere with one warning while other kinds continue', async () => {
    const c = clients({
      batch: {
        listNamespacedCronJob: vi
          .fn()
          .mockRejectedValue(new ApiException(403, 'cronjobs is forbidden', {}, {})),
      },
    });
    const f = new WorkloadFetcher(c, [demoNamespace, ns2], ['CronJob', 'Deployment']);
    const kinds: string[] = [];
    let cursor: string | undefined;
    let more = true;
    while (more) {
      const r = await f.fetch(cursor);
      kinds.push(...r.entities.map((e) => (e as { kind: string }).kind));
      cursor = r.cursor;
      more = r.has_more;
    }
    expect(kinds).toEqual(['Deployment', 'Deployment']);
    expect(f.warnings).toEqual([expect.stringMatching(/^FORBIDDEN:CronJob/)]);
    expect(c.batch.listNamespacedCronJob).toHaveBeenCalledTimes(1);
  });

  it('non-403 failures propagate as classified errors with status', async () => {
    const c = clients({
      apps: {
        listNamespacedDeployment: vi.fn().mockRejectedValue(new ApiException(401, 'nope', {}, {})),
      },
    });
    const f = new WorkloadFetcher(c, [demoNamespace], ['Deployment']);
    await expect(f.fetch()).rejects.toMatchObject({ code: 'UNAUTHORIZED', status: 401 });
  });

  it('fetchOne uses a fieldSelector for the refetch seam', async () => {
    const c = clients();
    const f = new WorkloadFetcher(c, [demoNamespace], ['Deployment']);
    const raw = await f.fetchOne('api-server');
    expect(raw?.object.metadata?.name).toBe('api-server');
    expect(c.apps.listNamespacedDeployment).toHaveBeenCalledWith(
      expect.objectContaining({ namespace: 'shipit', fieldSelector: 'metadata.name=api-server' }),
    );
  });
});
```

- [ ] **Step 2: Write the failing connector tests**

Create `packages/connectors/kubernetes/src/__tests__/connector.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { ApiException } from '@kubernetes/client-node';
import { KUBERNETES_DEFAULT_MAPPING } from '@shipit-ai/shared';
import type { ConnectorConfig } from '@shipit-ai/connector-sdk';
import { KubernetesConnector } from '../connector.js';
import type { KubeClients } from '../auth.js';
import { apiServerDeployment, redisStatefulSet } from './fixtures/demo-cluster.js';

const list = (items: unknown[]) => ({ items, metadata: {} });
const ns = (name: string, labels: Record<string, string> = {}) => ({ metadata: { name, labels } });

function fakeClients(overrides: Partial<Record<keyof KubeClients, unknown>> = {}): KubeClients {
  return {
    version: { getCode: vi.fn().mockResolvedValue({ gitVersion: 'v1.31.2' }) },
    core: {
      listNamespace: vi
        .fn()
        .mockResolvedValue(
          list([ns('shipit', { environment: 'production' }), ns('kube-system'), ns('monitoring')]),
        ),
      readNamespace: vi.fn().mockResolvedValue(ns('shipit', { environment: 'production' })),
      listNode: vi
        .fn()
        .mockResolvedValue(
          list([{ spec: { providerID: 'gce://p/z/n' }, metadata: { labels: {} } }]),
        ),
      listNamespacedPod: vi.fn().mockResolvedValue(list([])),
    },
    apps: {
      listNamespacedDeployment: vi.fn().mockResolvedValue(list([apiServerDeployment])),
      listNamespacedStatefulSet: vi.fn().mockResolvedValue(list([redisStatefulSet])),
      listNamespacedDaemonSet: vi.fn().mockResolvedValue(list([])),
      listNamespacedReplicaSet: vi.fn().mockResolvedValue(list([])),
    },
    batch: { listNamespacedCronJob: vi.fn().mockResolvedValue(list([])) },
    ...overrides,
  } as unknown as KubeClients;
}

function config(
  scope: Partial<Record<string, unknown>> = {},
  credentials: Record<string, string> = { mode: 'token', server: 'https://h', token: 't' },
): ConnectorConfig {
  return {
    id: 'k8s-demo',
    type: 'kubernetes',
    credentials,
    scope: {
      cluster: 'shipit-demo',
      namespaces: { include: ['*'], exclude: ['kube-system'] },
      kinds: ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob'],
      mapping: KUBERNETES_DEFAULT_MAPPING,
      githubOrg: 'Ship-It-Ops',
      knownRepositories: ['ShipIt-AI'],
      knownTeams: [],
      ...scope,
    },
  };
}

async function drain(connector: KubernetesConnector, type: string): Promise<unknown[]> {
  const out: unknown[] = [];
  let cursor: string | undefined;
  let more = true;
  while (more) {
    const r = await connector.fetch(type, cursor);
    out.push(...r.entities);
    cursor = r.cursor;
    more = r.has_more;
  }
  return out;
}

describe('KubernetesConnector', () => {
  it('has the expected manifest and discovery order', async () => {
    const c = new KubernetesConnector(() => fakeClients());
    expect(c.manifest).toMatchObject({
      name: 'kubernetes',
      supported_entity_types: [
        'Cluster',
        'Namespace',
        'Environment',
        'Deployment',
        'BuildArtifact',
        'LogicalService',
      ],
    });
    expect((await c.discover()).entity_types).toEqual(['Cluster', 'Namespace', 'Workload']);
  });

  it('authenticate probes /version and reports structured failures', async () => {
    const ok = new KubernetesConnector(() => fakeClients());
    expect(await ok.authenticate(config())).toEqual({ success: true });

    const unauthorized = new KubernetesConnector(() =>
      fakeClients({
        version: { getCode: vi.fn().mockRejectedValue(new ApiException(401, 'x', {}, {})) },
      }),
    );
    expect(await unauthorized.authenticate(config())).toEqual({
      success: false,
      error: 'UNAUTHORIZED: the API server rejected the credentials (401)',
    });

    const noCluster = new KubernetesConnector(() => fakeClients(), {
      inClusterProbe: { env: {}, fileExists: () => false },
    });
    const r = await noCluster.authenticate(config({}, { mode: 'in-cluster' }));
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/^IN_CLUSTER_UNAVAILABLE/);

    const badScope = new KubernetesConnector(() => fakeClients());
    expect((await badScope.authenticate(config({ cluster: '' }))).error).toMatch(/scope\.cluster/);
  });

  it('fetch walks Cluster → Namespace (scoped) → Workload and normalize dedupes shared nodes', async () => {
    const c = new KubernetesConnector(() => fakeClients());
    await c.authenticate(config());

    const cluster = await drain(c, 'Cluster');
    expect(cluster).toEqual([
      { __shipit: 'cluster', name: 'shipit-demo', version: 'v1.31.2', provider: 'gcp' },
    ]);

    const namespaces = await drain(c, 'Namespace');
    expect(
      namespaces.map((n) => (n as { object: { metadata: { name: string } } }).object.metadata.name),
    ).toEqual(['shipit', 'monitoring']);

    const workloads = await drain(c, 'Workload');
    expect(workloads).toHaveLength(4); // 2 kinds with items × 2 namespaces

    const entity = c.normalize([...cluster, ...namespaces, ...workloads]);
    const labels = entity.nodes.map((n) => n.label);
    expect(labels.filter((l) => l === 'Cluster')).toHaveLength(1);
    expect(labels.filter((l) => l === 'Namespace')).toHaveLength(2);
    expect(labels.filter((l) => l === 'Deployment')).toHaveLength(4);
    // one shared Environment (production) and one shared LogicalService (shipit-ai) despite 4 workloads
    expect(labels.filter((l) => l === 'Environment')).toHaveLength(1);
    expect(labels.filter((l) => l === 'LogicalService')).toHaveLength(1);
    expect(
      entity.edges.some(
        (e) =>
          e.type === 'IMPLEMENTED_BY' &&
          e.to === 'shipit://repository/default/Ship-It-Ops/ShipIt-AI',
      ),
    ).toBe(true);
    expect(c.getWarnings()).toEqual([]);
  });

  it('normalize keeps the highest-confidence edge per (type, from, to) across workloads', async () => {
    const c = new KubernetesConnector(() => fakeClients());
    await c.authenticate(config());
    await drain(c, 'Namespace');
    const entity = c.normalize(await drain(c, 'Workload'));
    // api-server carries the annotation (1.0); redis links by app label (0.6);
    // both target the same LogicalService → Repository edge.
    const implementedBy = entity.edges.filter((e) => e.type === 'IMPLEMENTED_BY');
    expect(implementedBy).toHaveLength(1);
    expect(implementedBy[0]).toMatchObject({
      _confidence: 1.0,
      properties: { link_method: 'annotation' },
    });
  });

  it('Workload before Namespace, or an empty namespace scope, is NAMESPACE_SCOPE_EMPTY', async () => {
    const c = new KubernetesConnector(() => fakeClients());
    await c.authenticate(config({ namespaces: { include: ['nothing-*'], exclude: [] } }));
    await drain(c, 'Namespace');
    await expect(c.fetch('Workload')).rejects.toMatchObject({ code: 'NAMESPACE_SCOPE_EMPTY' });
  });

  it('a forbidden namespace list surfaces with status 403 so the harness flags auth', async () => {
    const c = new KubernetesConnector(() =>
      fakeClients({
        core: {
          listNamespace: vi
            .fn()
            .mockRejectedValue(new ApiException(403, 'namespaces is forbidden', {}, {})),
          listNode: vi.fn(),
          listNamespacedPod: vi.fn(),
          readNamespace: vi.fn(),
        },
      }),
    );
    await c.authenticate(config());
    await expect(c.fetch('Namespace')).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });

  it('per-kind forbidden becomes a warning exposed via getWarnings()', async () => {
    const c = new KubernetesConnector(() =>
      fakeClients({
        batch: {
          listNamespacedCronJob: vi
            .fn()
            .mockRejectedValue(new ApiException(403, 'cronjobs is forbidden', {}, {})),
        },
      }),
    );
    await c.authenticate(config());
    await drain(c, 'Namespace');
    await drain(c, 'Workload');
    expect(c.getWarnings()).toEqual([expect.stringMatching(/^FORBIDDEN:CronJob/)]);
  });

  it('sync() runs the full loop and reports counts', async () => {
    const c = new KubernetesConnector(() => fakeClients());
    await c.authenticate(config());
    const r = await c.sync('full');
    expect(r.status).toBe('success');
    expect(r.entities_synced).toBe(1 + 2 + 4);
  });

  it('refetchWorkload produces the same Deployment node as the full pass', async () => {
    const c = new KubernetesConnector(() => fakeClients());
    await c.authenticate(config());
    await drain(c, 'Namespace');
    const full = c.normalize(await drain(c, 'Workload'));
    const one = await c.refetchWorkload('shipit', 'Deployment', 'api-server');
    const id = 'shipit://deployment/default/shipit-demo/shipit/deployment/api-server';
    const a = full.nodes.find((n) => n.id === id)!;
    const b = one.nodes.find((n) => n.id === id)!;
    expect(b.properties).toEqual(a.properties);
    expect(b._event_version).toEqual(a._event_version);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd packages/connectors/kubernetes && npx vitest run src/__tests__/fetchers.test.ts src/__tests__/connector.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Shared default mapping**

In `packages/shared/src/config/schema.ts`, after `export type KubernetesAccessConfig = …`:

```ts
/** Fully-defaulted mapping block — what an instance gets when `mapping` is omitted. */
export const KUBERNETES_DEFAULT_MAPPING: KubernetesMappingConfig = kubernetesMappingSchema.parse(
  {},
);
```

Export `KUBERNETES_DEFAULT_MAPPING` from `packages/shared/src/config/index.ts` and `packages/shared/src/index.ts` (value exports, beside `KUBERNETES_WORKLOAD_KINDS`).

- [ ] **Step 5: `fetchers/common.ts`**

```ts
import type { V1Namespace } from '@kubernetes/client-node';
import { KubernetesError } from '../auth.js';
import type { NamespaceRef } from '../types.js';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const PAGE_LIMIT = 500;

/** Per-call timeout; the API client has none of its own that we control. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new KubernetesError('TIMEOUT', `${what} exceeded ${ms} ms`)),
      ms,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

/** Namespace scope: any include glob must match and no exclude glob may match. */
export function matchesScope(name: string, include: string[], exclude: string[]): boolean {
  if (!include.some((g) => globToRegExp(g).test(name))) return false;
  return !exclude.some((g) => globToRegExp(g).test(name));
}

export function toNamespaceRef(ns: V1Namespace): NamespaceRef {
  return {
    name: ns.metadata?.name ?? '',
    labels: ns.metadata?.labels ?? {},
    annotations: ns.metadata?.annotations ?? {},
  };
}
```

- [ ] **Step 6: `fetchers/cluster.ts` and `fetchers/namespaces.ts`**

```ts
// cluster.ts
import type { KubeClients } from '../auth.js';
import type { RawCluster } from '../types.js';
import { DEFAULT_TIMEOUT_MS, withTimeout } from './common.js';

export function providerFromId(providerId: string | undefined): string | undefined {
  if (!providerId) return undefined;
  const scheme = providerId.split('://')[0];
  switch (scheme) {
    case 'gce':
      return 'gcp';
    case 'aws':
      return 'aws';
    case 'azure':
      return 'azure';
    default:
      return scheme || undefined;
  }
}

/** One record per run. Version is required (authenticate already proved it); nodes are optional. */
export async function fetchClusterSummary(
  clients: KubeClients,
  clusterName: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<RawCluster> {
  const version = await withTimeout(clients.version.getCode(), timeoutMs, 'GET /version');
  const raw: RawCluster = { __shipit: 'cluster', name: clusterName };
  if (version.gitVersion) raw.version = version.gitVersion;
  try {
    const nodes = await withTimeout(clients.core.listNode({ limit: 100 }), timeoutMs, 'list nodes');
    const first = nodes.items[0];
    if (first) {
      const provider = providerFromId(first.spec?.providerID);
      if (provider) raw.provider = provider;
      const labels = first.metadata?.labels ?? {};
      const region =
        labels['topology.kubernetes.io/region'] ??
        labels['failure-domain.beta.kubernetes.io/region'];
      if (region) raw.region = region;
    }
  } catch {
    // RBAC may deny `list nodes`; provider/region simply stay unset.
  }
  return raw;
}
```

```ts
// namespaces.ts
import type { KubeClients } from '../auth.js';
import type { NamespaceRef, RawNamespace } from '../types.js';
import {
  DEFAULT_TIMEOUT_MS,
  PAGE_LIMIT,
  matchesScope,
  toNamespaceRef,
  withTimeout,
} from './common.js';

export interface NamespacePage {
  entities: RawNamespace[];
  refs: NamespaceRef[];
  cursor?: string;
  has_more: boolean;
}

export async function fetchNamespaces(
  clients: KubeClients,
  scope: { include: string[]; exclude: string[] },
  cursor: string | undefined,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<NamespacePage> {
  const list = await withTimeout(
    clients.core.listNamespace({ limit: PAGE_LIMIT, _continue: cursor }),
    timeoutMs,
    'list namespaces',
  );
  const items = list.items.filter((ns) =>
    matchesScope(ns.metadata?.name ?? '', scope.include, scope.exclude),
  );
  const next = list.metadata?._continue || undefined;
  return {
    entities: items.map((object) => ({ __shipit: 'namespace', object })),
    refs: items.map(toNamespaceRef),
    cursor: next,
    has_more: Boolean(next),
  };
}

export async function fetchNamespaceRef(
  clients: KubeClients,
  name: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<NamespaceRef> {
  const ns = await withTimeout(
    clients.core.readNamespace({ name }),
    timeoutMs,
    `get namespace ${name}`,
  );
  return toNamespaceRef(ns);
}
```

- [ ] **Step 7: `fetchers/workloads.ts`**

```ts
import type { V1OwnerReference, V1Pod, V1ReplicaSet } from '@kubernetes/client-node';
import type { FetchResult } from '@shipit-ai/connector-sdk';
import { classifyError, type KubeClients } from '../auth.js';
import type {
  NamespaceRef,
  PodSummary,
  RawWorkload,
  WorkloadKind,
  WorkloadObject,
} from '../types.js';
import { DEFAULT_TIMEOUT_MS, PAGE_LIMIT, withTimeout } from './common.js';

interface NamespaceCache {
  pods: V1Pod[];
  replicaSets: V1ReplicaSet[];
}

interface Position {
  nsIndex: number;
  kindIndex: number;
}

// Cursor = JSON [nsIndex, kindIndex, continueToken]; K8s continue tokens are opaque.
function encodeCursor(nsIndex: number, kindIndex: number, continueToken?: string): string {
  return JSON.stringify([nsIndex, kindIndex, continueToken ?? null]);
}

function decodeCursor(cursor: string | undefined): Position & { continueToken?: string } {
  if (!cursor) return { nsIndex: 0, kindIndex: 0 };
  const [nsIndex, kindIndex, continueToken] = JSON.parse(cursor) as [number, number, string | null];
  return { nsIndex, kindIndex, continueToken: continueToken ?? undefined };
}

function advance(pos: Position, kindCount: number): Position {
  return pos.kindIndex + 1 < kindCount
    ? { nsIndex: pos.nsIndex, kindIndex: pos.kindIndex + 1 }
    : { nsIndex: pos.nsIndex + 1, kindIndex: 0 };
}

export function digestFromImageId(imageId: string | undefined): string | undefined {
  if (!imageId) return undefined;
  const at = imageId.lastIndexOf('@');
  if (at === -1) return undefined;
  const digest = imageId.slice(at + 1);
  return /^sha256:[a-f0-9]{64}$/.test(digest) ? digest : undefined;
}

function ownedBy(refs: V1OwnerReference[] | undefined, kind: string, name: string): boolean {
  return (refs ?? []).some((o) => o.kind === kind && o.name === name);
}

/** Roll a namespace's pods up to one workload. Deployment → ReplicaSet → Pod; others own pods directly. */
export function summarizePods(
  kind: WorkloadKind,
  object: WorkloadObject,
  cache: NamespaceCache | null,
): PodSummary {
  const summary: PodSummary = { readyPods: 0, restarts: 0, imageDigests: {} };
  if (!cache || kind === 'CronJob') return summary;
  const name = object.metadata?.name ?? '';
  let owned: V1Pod[];
  if (kind === 'Deployment') {
    const rsNames = new Set(
      cache.replicaSets
        .filter((rs) => ownedBy(rs.metadata?.ownerReferences, 'Deployment', name))
        .map((rs) => rs.metadata?.name ?? ''),
    );
    owned = cache.pods.filter((p) =>
      (p.metadata?.ownerReferences ?? []).some(
        (o) => o.kind === 'ReplicaSet' && rsNames.has(o.name),
      ),
    );
  } else {
    owned = cache.pods.filter((p) => ownedBy(p.metadata?.ownerReferences, kind, name));
  }
  for (const pod of owned) {
    if ((pod.status?.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'))
      summary.readyPods++;
    for (const cs of pod.status?.containerStatuses ?? []) {
      summary.restarts += cs.restartCount ?? 0;
      const digest = digestFromImageId(cs.imageID);
      if (digest && !summary.imageDigests[cs.name]) summary.imageDigests[cs.name] = digest;
    }
  }
  return summary;
}

/**
 * Stateful pager over (namespace × kind). Lists pods + ReplicaSets once per
 * namespace and matches in memory. A 403 on one kind records a warning and
 * skips that kind for every namespace; any other failure propagates classified.
 */
export class WorkloadFetcher {
  private readonly cache = new Map<string, NamespaceCache>();
  private readonly forbiddenKinds = new Set<WorkloadKind>();
  readonly warnings: string[] = [];

  constructor(
    private readonly clients: KubeClients,
    private readonly namespaces: NamespaceRef[],
    private readonly kinds: WorkloadKind[],
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  async fetch(cursor?: string): Promise<FetchResult> {
    let pos: Position & { continueToken?: string } = decodeCursor(cursor);
    while (
      pos.nsIndex < this.namespaces.length &&
      this.forbiddenKinds.has(this.kinds[pos.kindIndex])
    ) {
      pos = advance(pos, this.kinds.length);
    }
    if (pos.nsIndex >= this.namespaces.length) return { entities: [], has_more: false };

    const ns = this.namespaces[pos.nsIndex];
    const kind = this.kinds[pos.kindIndex];
    let page: { items: WorkloadObject[]; continueToken?: string };
    try {
      page = await this.listKind(ns.name, kind, pos.continueToken);
    } catch (err) {
      const classified = classifyError(err);
      if (classified.code === 'FORBIDDEN') {
        this.forbiddenKinds.add(kind);
        this.warnings.push(
          `FORBIDDEN:${kind} — listing ${kind} in namespace "${ns.name}" was denied; grant list on ${kind.toLowerCase()}s to the ShipIt ServiceAccount`,
        );
        return this.emptyPage(advance(pos, this.kinds.length));
      }
      throw classified;
    }

    const cache = kind === 'CronJob' ? null : await this.namespaceCache(ns.name);
    const entities: RawWorkload[] = page.items.map((object) => ({
      __shipit: 'workload',
      kind,
      object,
      namespace: ns,
      pods: summarizePods(kind, object, cache),
    }));
    if (page.continueToken) {
      return {
        entities,
        cursor: encodeCursor(pos.nsIndex, pos.kindIndex, page.continueToken),
        has_more: true,
      };
    }
    const next = advance(pos, this.kinds.length);
    const done = next.nsIndex >= this.namespaces.length;
    return {
      entities,
      cursor: done ? undefined : encodeCursor(next.nsIndex, next.kindIndex),
      has_more: !done,
    };
  }

  /** Refetch seam: exactly one workload of `kinds[0]` in `namespaces[0]` by name. */
  async fetchOne(name: string): Promise<RawWorkload | null> {
    const ns = this.namespaces[0];
    const kind = this.kinds[0];
    const page = await this.listKind(ns.name, kind, undefined, `metadata.name=${name}`);
    const object = page.items[0];
    if (!object) return null;
    const cache = kind === 'CronJob' ? null : await this.namespaceCache(ns.name);
    return {
      __shipit: 'workload',
      kind,
      object,
      namespace: ns,
      pods: summarizePods(kind, object, cache),
    };
  }

  private emptyPage(next: Position): FetchResult {
    const done = next.nsIndex >= this.namespaces.length;
    return {
      entities: [],
      cursor: done ? undefined : encodeCursor(next.nsIndex, next.kindIndex),
      has_more: !done,
    };
  }

  private async listKind(
    namespace: string,
    kind: WorkloadKind,
    continueToken?: string,
    fieldSelector?: string,
  ): Promise<{ items: WorkloadObject[]; continueToken?: string }> {
    const param = { namespace, limit: PAGE_LIMIT, _continue: continueToken, fieldSelector };
    const what = `list ${kind} in ${namespace}`;
    const call = () => {
      switch (kind) {
        case 'Deployment':
          return this.clients.apps.listNamespacedDeployment(param);
        case 'StatefulSet':
          return this.clients.apps.listNamespacedStatefulSet(param);
        case 'DaemonSet':
          return this.clients.apps.listNamespacedDaemonSet(param);
        case 'CronJob':
          return this.clients.batch.listNamespacedCronJob(param);
      }
    };
    const list = await withTimeout(call(), this.timeoutMs, what);
    return {
      items: list.items as WorkloadObject[],
      continueToken: list.metadata?._continue || undefined,
    };
  }

  private async namespaceCache(namespace: string): Promise<NamespaceCache> {
    const hit = this.cache.get(namespace);
    if (hit) return hit;
    const [pods, replicaSets] = await Promise.all([
      this.listAll<V1Pod>(
        (c) => this.clients.core.listNamespacedPod({ namespace, limit: PAGE_LIMIT, _continue: c }),
        `list pods in ${namespace}`,
      ),
      this.listAll<V1ReplicaSet>(
        (c) =>
          this.clients.apps.listNamespacedReplicaSet({
            namespace,
            limit: PAGE_LIMIT,
            _continue: c,
          }),
        `list replicasets in ${namespace}`,
      ),
    ]);
    const entry = { pods, replicaSets };
    this.cache.set(namespace, entry);
    return entry;
  }

  private async listAll<T>(
    page: (continueToken?: string) => Promise<{ items: T[]; metadata?: { _continue?: string } }>,
    what: string,
  ): Promise<T[]> {
    const out: T[] = [];
    let token: string | undefined;
    do {
      let list: { items: T[]; metadata?: { _continue?: string } };
      try {
        list = await withTimeout(page(token), this.timeoutMs, what);
      } catch (err) {
        const classified = classifyError(err);
        if (classified.code === 'FORBIDDEN') {
          this.warnings.push(
            `FORBIDDEN:${what} — pod/replicaset rollups (ready counts, restarts, digests) disabled for this namespace`,
          );
          return out;
        }
        throw classified;
      }
      out.push(...list.items);
      token = list.metadata?._continue || undefined;
    } while (token);
    return out;
  }
}
```

- [ ] **Step 8: `connector.ts` and `index.ts`**

```ts
// connector.ts
import type {
  CanonicalEdge,
  CanonicalEntity,
  CanonicalNode,
  KubernetesMappingConfig,
} from '@shipit-ai/shared';
import { KUBERNETES_WORKLOAD_KINDS } from '@shipit-ai/shared';
import type {
  AuthResult,
  ConnectorConfig,
  ConnectorManifest,
  DiscoveryResult,
  FetchResult,
  ShipItConnector,
  SyncResult,
} from '@shipit-ai/connector-sdk';
import {
  buildKubeConfig,
  classifyError,
  defaultClientFactory,
  KubernetesError,
  parseCredentials,
  type ClientFactory,
  type InClusterProbe,
  type KubeClients,
} from './auth.js';
import { DEFAULT_TIMEOUT_MS, withTimeout } from './fetchers/common.js';
import { fetchClusterSummary } from './fetchers/cluster.js';
import { fetchNamespaceRef, fetchNamespaces } from './fetchers/namespaces.js';
import { WorkloadFetcher } from './fetchers/workloads.js';
import { normalizeCluster } from './normalizers/cluster.js';
import { normalizeNamespace } from './normalizers/namespace.js';
import { normalizeWorkload } from './normalizers/workload.js';
import type {
  NamespaceRef,
  NormalizeOutput,
  NormalizerContext,
  RawRecord,
  WorkloadKind,
} from './types.js';

/** `ConnectorConfig.scope` as the api-server factory builds it (Task 11). */
export interface KubernetesScopeOptions {
  cluster: string;
  namespaces: { include: string[]; exclude: string[] };
  kinds: WorkloadKind[];
  mapping: KubernetesMappingConfig;
  githubOrg: string | null;
  knownRepositories: string[];
  knownTeams: string[];
}

function parseScope(scope: Record<string, unknown>): KubernetesScopeOptions {
  const cluster = typeof scope.cluster === 'string' ? scope.cluster.trim() : '';
  if (!cluster) throw new Error('scope.cluster is required');
  if (!scope.mapping || typeof scope.mapping !== 'object')
    throw new Error('scope.mapping is required');
  const namespaces =
    (scope.namespaces as { include?: string[]; exclude?: string[] } | undefined) ?? {};
  const kinds = (
    Array.isArray(scope.kinds) && scope.kinds.length > 0
      ? scope.kinds
      : [...KUBERNETES_WORKLOAD_KINDS]
  ) as WorkloadKind[];
  return {
    cluster,
    namespaces: {
      include: namespaces.include ?? ['*'],
      exclude: namespaces.exclude ?? ['kube-system', 'kube-public', 'kube-node-lease'],
    },
    kinds,
    mapping: scope.mapping as KubernetesMappingConfig,
    githubOrg: typeof scope.githubOrg === 'string' && scope.githubOrg ? scope.githubOrg : null,
    knownRepositories: Array.isArray(scope.knownRepositories)
      ? (scope.knownRepositories as string[])
      : [],
    knownTeams: Array.isArray(scope.knownTeams) ? (scope.knownTeams as string[]) : [],
  };
}

export interface KubernetesConnectorOptions {
  timeoutMs?: number;
  inClusterProbe?: InClusterProbe;
}

export class KubernetesConnector implements ShipItConnector {
  readonly manifest: ConnectorManifest = {
    name: 'kubernetes',
    version: '1.0.0',
    schema_version: '1.0',
    min_sdk_version: '0.1.0',
    supported_entity_types: [
      'Cluster',
      'Namespace',
      'Environment',
      'Deployment',
      'BuildArtifact',
      'LogicalService',
    ],
  };

  private readonly clientFactory: ClientFactory;
  private readonly timeoutMs: number;
  private readonly inClusterProbe?: InClusterProbe;
  private clients: KubeClients | null = null;
  private scope: KubernetesScopeOptions | null = null;
  private namespaces: NamespaceRef[] = [];
  private workloadFetcher: WorkloadFetcher | null = null;
  private readonly warnings = new Set<string>();

  constructor(
    clientFactory: ClientFactory = defaultClientFactory,
    options: KubernetesConnectorOptions = {},
  ) {
    this.clientFactory = clientFactory;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.inClusterProbe = options.inClusterProbe;
  }

  /** Non-fatal run problems (e.g. `FORBIDDEN:<kind>`); the scheduler folds them into the run record. */
  getWarnings(): string[] {
    return [...this.warnings];
  }

  async authenticate(config: ConnectorConfig): Promise<AuthResult> {
    try {
      this.scope = parseScope(config.scope);
    } catch (err) {
      return { success: false, error: (err as Error).message };
    }
    let clients: KubeClients;
    try {
      const kc = buildKubeConfig(parseCredentials(config.credentials), this.inClusterProbe);
      clients = this.clientFactory(kc);
      await withTimeout(clients.version.getCode(), this.timeoutMs, 'GET /version');
    } catch (err) {
      return { success: false, error: classifyError(err).message };
    }
    this.clients = clients;
    this.namespaces = [];
    this.workloadFetcher = null;
    this.warnings.clear();
    return { success: true };
  }

  async discover(): Promise<DiscoveryResult> {
    // Order matters: namespaces (and their environments) publish before workloads.
    return { entity_types: ['Cluster', 'Namespace', 'Workload'], total_entities: {} };
  }

  async fetch(entityType: string, cursor?: string): Promise<FetchResult> {
    const clients = this.requireClients();
    const scope = this.requireScope();
    try {
      switch (entityType) {
        case 'Cluster':
          return {
            entities: [await fetchClusterSummary(clients, scope.cluster, this.timeoutMs)],
            has_more: false,
          };
        case 'Namespace': {
          const page = await fetchNamespaces(clients, scope.namespaces, cursor, this.timeoutMs);
          if (!cursor) this.namespaces = [];
          this.namespaces.push(...page.refs);
          return { entities: page.entities, cursor: page.cursor, has_more: page.has_more };
        }
        case 'Workload': {
          if (this.namespaces.length === 0) {
            throw new KubernetesError(
              'NAMESPACE_SCOPE_EMPTY',
              'no namespaces matched scope.namespaces.include/exclude (or Namespace was not fetched first)',
            );
          }
          if (!this.workloadFetcher) {
            this.workloadFetcher = new WorkloadFetcher(
              clients,
              this.namespaces,
              scope.kinds,
              this.timeoutMs,
            );
          }
          const result = await this.workloadFetcher.fetch(cursor);
          for (const w of this.workloadFetcher.warnings.splice(0)) this.warnings.add(w);
          return result;
        }
        default:
          return { entities: [], has_more: false };
      }
    } catch (err) {
      // The harness sniffs `status` (401/403) to mark the instance degraded.
      throw classifyError(err);
    }
  }

  normalize(raw: unknown[]): CanonicalEntity {
    const ctx = this.normalizerContext();
    const nodes = new Map<string, CanonicalNode>();
    const edges = new Map<string, CanonicalEdge>();
    for (const record of raw as RawRecord[]) {
      let out: NormalizeOutput;
      switch (record.__shipit) {
        case 'cluster':
          out = normalizeCluster(record, ctx);
          break;
        case 'namespace':
          out = normalizeNamespace(record, ctx);
          break;
        case 'workload':
          out = normalizeWorkload(record, ctx);
          break;
        default:
          continue;
      }
      for (const n of out.nodes) if (!nodes.has(n.id)) nodes.set(n.id, n);
      for (const e of out.edges) {
        // Several workloads of one LogicalService may link the same Repository
        // at different confidences (annotation 1.0 on one, app-label 0.6 on
        // another). mergeEdge is last-writer-wins, so keep the best per
        // (type, from, to) within a batch.
        const key = `${e.type}|${e.from}|${e.to}`;
        const prev = edges.get(key);
        if (!prev || e._confidence > prev._confidence) edges.set(key, e);
      }
      for (const w of out.warnings) this.warnings.add(w);
    }
    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }

  /** Refetch seam for a later watch/webhook layer: one workload through the same normalize(). */
  async refetchWorkload(
    namespace: string,
    kind: WorkloadKind,
    name: string,
  ): Promise<CanonicalEntity> {
    const clients = this.requireClients();
    const ref =
      this.namespaces.find((n) => n.name === namespace) ??
      (await fetchNamespaceRef(clients, namespace, this.timeoutMs));
    const fetcher = new WorkloadFetcher(clients, [ref], [kind], this.timeoutMs);
    const raw = await fetcher.fetchOne(name);
    return raw ? this.normalize([raw]) : { nodes: [], edges: [] };
  }

  async sync(mode: 'full' | 'incremental'): Promise<SyncResult> {
    void mode; // every Kubernetes run is a full list
    const startTime = Date.now();
    let entitiesSynced = 0;
    const errors: string[] = [];
    try {
      for (const entityType of (await this.discover()).entity_types) {
        let cursor: string | undefined;
        let hasMore = true;
        while (hasMore) {
          const result = await this.fetch(entityType, cursor);
          entitiesSynced += result.entities.length;
          cursor = result.cursor;
          hasMore = result.has_more;
        }
      }
      return {
        status: errors.length > 0 ? 'partial' : 'success',
        entities_synced: entitiesSynced,
        errors,
        duration_ms: Date.now() - startTime,
      };
    } catch (err) {
      return {
        status: 'failed',
        entities_synced: entitiesSynced,
        errors: [(err as Error).message],
        duration_ms: Date.now() - startTime,
      };
    }
  }

  private requireClients(): KubeClients {
    if (!this.clients) throw new Error('Not authenticated. Call authenticate() first.');
    return this.clients;
  }

  private requireScope(): KubernetesScopeOptions {
    if (!this.scope) throw new Error('Not authenticated. Call authenticate() first.');
    return this.scope;
  }

  private normalizerContext(): NormalizerContext {
    const scope = this.requireScope();
    return {
      cluster: scope.cluster,
      mapping: scope.mapping,
      githubOrg: scope.githubOrg,
      knownRepositories: scope.knownRepositories,
      knownTeams: scope.knownTeams,
      // Stamped per normalize() call so `_last_synced` is always after the run's startedAt.
      now: new Date().toISOString(),
    };
  }
}
```

Replace `packages/connectors/kubernetes/src/index.ts` with:

```ts
export { KubernetesConnector } from './connector.js';
export type { KubernetesConnectorOptions, KubernetesScopeOptions } from './connector.js';
export {
  KubernetesError,
  buildKubeConfig,
  classifyError,
  defaultClientFactory,
  parseCredentials,
  validateKubeconfigText,
  SERVICE_ACCOUNT_TOKEN_PATH,
} from './auth.js';
export type {
  ClientFactory,
  InClusterProbe,
  KubeClients,
  KubernetesAccessCredentials,
  KubernetesErrorCode,
  KubeconfigValidation,
} from './auth.js';
export { fetchClusterSummary } from './fetchers/cluster.js';
export { fetchNamespaces, fetchNamespaceRef } from './fetchers/namespaces.js';
export { WorkloadFetcher, summarizePods } from './fetchers/workloads.js';
export { matchesScope, withTimeout } from './fetchers/common.js';
export { normalizeCluster } from './normalizers/cluster.js';
export { normalizeNamespace } from './normalizers/namespace.js';
export { normalizeWorkload, deriveServiceName } from './normalizers/workload.js';
export { resolveRepositoryLink, resolveTeamLink } from './normalizers/linking.js';
export { deriveEnvironment } from './normalizers/environment.js';
export { ids, keys, parseImageRef } from './normalizers/identity.js';
export type * from './types.js';
export { EMPTY_POD_SUMMARY } from './types.js';
```

- [ ] **Step 9: Run everything in the package**

Run: `cd packages/connectors/kubernetes && npx vitest run && npx tsc --noEmit && cd ../../.. && pnpm turbo build --filter=@shipit-ai/connector-kubernetes`
Expected: all tests PASS, clean typecheck, `dist/` produced.

- [ ] **Step 10: Commit**

```bash
git add packages/shared/src packages/connectors/kubernetes/src
git commit -m "connector-kubernetes: paged fetchers, pod rollups and the KubernetesConnector"
```

---

### Task 10: api-server connector-type factory (GitHub behavior-preserving)

Implements spec §Connector-type factory and the `pollMode` / `sync.completed` emission in §Absence sweep. **No Kubernetes code in the api-server yet** — this task ends with every existing GitHub test green on the new seams.

**Files:**

- Create: `packages/api-server/src/services/connector-types/types.ts`, `github.ts`, `index.ts`
- Modify: `packages/api-server/src/services/sync-scheduler.ts`
- Modify: `packages/api-server/src/services/connector-registry.ts`
- Modify: `packages/api-server/src/services/sync-runtime.ts`
- Modify: `packages/api-server/src/index.ts` (the `wireSyncRuntime({...})` call)
- Modify: `packages/api-server/src/routes/connectors.ts` (type guards only)
- Test: `packages/api-server/src/__tests__/services/connector-types.test.ts` (create)
- Test: `packages/api-server/src/__tests__/services/sync-scheduler.test.ts` (extend)
- Test: `packages/api-server/src/__tests__/services/connector-registry.test.ts` (extend)

**Interfaces:**

- Produces (`connector-types/types.ts`):
  ```ts
  export interface BuildContext {
    globalApp: AppLike; // LIVE reference (live-reference-for-hot-reload)
    readPrivateKey(path: string): string;
    keyDir: string; // absolute key directory
    lookupRepositoryNames?(org: string): Promise<string[]>;
    lookupTeamSlugs?(org: string): Promise<string[]>;
    listConnectors(): ConnectorInstanceConfig[];
  }
  export type BuiltConnector = ShipItConnector & { getWarnings?(): string[] };
  export type BuildResult =
    | { ok: true; connector: BuiltConnector; sdkConfig: ConnectorConfig }
    | { ok: false; code: string; message: string };
  export interface ProbeResult {
    ok: boolean;
    code?: string;
    message?: string;
    [key: string]: unknown;
  }
  export interface ConnectorType<C extends ConnectorInstanceConfig = ConnectorInstanceConfig> {
    readonly type: C['type'];
    readonly pollMode: 'full' | 'incremental';
    build(cfg: C, ctx: BuildContext): Promise<BuildResult>;
    probe?(body: unknown, ctx: BuildContext): Promise<ProbeResult>;
  }
  ```
  (`connector-types/index.ts`): `getConnectorType(type: string): ConnectorType | undefined`, `connectorTypeFor(cfg): ConnectorType` (throws), `CONNECTOR_TYPES`.
- `SyncSchedulerOptions` gains `keyDir?: string`, `lookupRepositoryNames?`, `lookupTeamSlugs?`. `ConnectorRunner.start/triggerSync` take `ConnectorInstanceConfig`. `CreateConnectorInput` / `UpdateConnectorInput` become exported unions (kubernetes member used by Task 11).
- Consumed by: Task 11.

- [ ] **Step 1: Write the failing factory test**

Create `packages/api-server/src/__tests__/services/connector-types.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { GitHubConnectorConfig } from '@shipit-ai/shared';
import { connectorInstanceSchema } from '@shipit-ai/shared';
import { getConnectorType, connectorTypeFor } from '../../services/connector-types/index.js';
import type { BuildContext } from '../../services/connector-types/types.js';

function ctx(overrides: Partial<BuildContext> = {}): BuildContext {
  return {
    globalApp: { id: 'app-1', privateKeyPath: '/keys/global.pem' },
    readPrivateKey: vi.fn().mockReturnValue('PEM'),
    keyDir: '/keys',
    listConnectors: () => [],
    ...overrides,
  };
}

const gh = connectorInstanceSchema.parse({
  id: 'gh-acme',
  type: 'github',
  name: 'Acme',
  installationId: '42',
  org: 'acme',
}) as GitHubConnectorConfig;

describe('connector-types registry', () => {
  it('knows github (incremental poll) and nothing else yet', () => {
    expect(getConnectorType('github')?.pollMode).toBe('incremental');
    expect(getConnectorType('nope')).toBeUndefined();
    expect(() => connectorTypeFor({ ...gh, type: 'nope' as never })).toThrow(
      /No connector type registered/,
    );
  });
});

describe('github connector type', () => {
  it('builds a GitHubConnector with the resolved App credentials and installation', async () => {
    const c = ctx();
    const built = await getConnectorType('github')!.build(gh, c);
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error('unreachable');
    expect(built.connector.manifest.name).toBe('github');
    expect(built.sdkConfig).toEqual({
      id: 'gh-acme',
      type: 'github',
      credentials: { appId: 'app-1', privateKey: 'PEM', installationId: '42' },
      scope: { org: 'acme' },
    });
    expect(c.readPrivateKey).toHaveBeenCalledWith('/keys/global.pem');
  });

  it('prefers the per-connector App override', async () => {
    const c = ctx();
    const built = await getConnectorType('github')!.build(
      { ...gh, app: { id: 'app-2', privateKeyPath: '/keys/override.pem' } },
      c,
    );
    if (!built.ok) throw new Error('unreachable');
    expect(built.sdkConfig.credentials.appId).toBe('app-2');
    expect(c.readPrivateKey).toHaveBeenCalledWith('/keys/override.pem');
  });

  it('fails structurally when no App is configured or the key is unreadable', async () => {
    const none = await getConnectorType('github')!.build(
      gh,
      ctx({ globalApp: { id: '', privateKeyPath: '' } }),
    );
    expect(none).toMatchObject({ ok: false, code: 'APP_NOT_CONFIGURED' });
    const unreadable = await getConnectorType('github')!.build(
      gh,
      ctx({
        readPrivateKey: () => {
          throw new Error('ENOENT');
        },
      }),
    );
    expect(unreadable).toMatchObject({
      ok: false,
      code: 'PRIVATE_KEY_UNREADABLE',
      message: expect.stringContaining('ENOENT'),
    });
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/api-server && npx vitest run src/__tests__/services/connector-types.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the factory**

`packages/api-server/src/services/connector-types/types.ts`:

```ts
import type { ConnectorConfig, ShipItConnector } from '@shipit-ai/connector-sdk';
import type { AppLike, ConnectorInstanceConfig } from '@shipit-ai/shared';

/** What a connector type may need to turn a stored instance into a runnable connector. */
export interface BuildContext {
  // LIVE reference to the global GitHub App — the same object GitHubAppService
  // mutates on PUT /github/app. See docs/agent/patterns/live-reference-for-hot-reload.md.
  globalApp: AppLike;
  // Memoized in the scheduler (one disk read per path per process), plain
  // readFileSync in routes. Always fed a path already pinned to the key dir.
  readPrivateKey(path: string): string;
  // Absolute directory every credential file lives in (SHIPIT_GITHUB_APP_KEY_DIR).
  keyDir: string;
  // Graph lookups the Kubernetes linking tiers use (source-cased repo names,
  // team slugs for a GitHub org). Optional: absent in unit tests / no Neo4j.
  lookupRepositoryNames?(org: string): Promise<string[]>;
  lookupTeamSlugs?(org: string): Promise<string[]>;
  listConnectors(): ConnectorInstanceConfig[];
}

export type BuiltConnector = ShipItConnector & { getWarnings?(): string[] };

export type BuildResult =
  | { ok: true; connector: BuiltConnector; sdkConfig: ConnectorConfig }
  | { ok: false; code: string; message: string };

export interface ProbeResult {
  ok: boolean;
  code?: string;
  message?: string;
  [key: string]: unknown;
}

export interface ConnectorType<C extends ConnectorInstanceConfig = ConnectorInstanceConfig> {
  readonly type: C['type'];
  /**
   * Mode the repeatable poll job enqueues. GitHub polls `incremental` (webhooks
   * carry the deltas); Kubernetes lists the whole cluster every run, so it polls
   * `full` and every successful poll triggers the absence sweep.
   */
  readonly pollMode: 'full' | 'incremental';
  build(cfg: C, ctx: BuildContext): Promise<BuildResult>;
  /** Types whose probe lives in the factory (Kubernetes); GitHub's stays in the route. */
  probe?(body: unknown, ctx: BuildContext): Promise<ProbeResult>;
}
```

`packages/api-server/src/services/connector-types/github.ts` (the credential resolution moves here from the scheduler, byte-for-byte semantics):

```ts
import { GitHubConnector } from '@shipit-ai/connector-github';
import { resolveAppCredentials, type GitHubConnectorConfig } from '@shipit-ai/shared';
import type { BuildResult, ConnectorType } from './types.js';

export const githubConnectorType: ConnectorType<GitHubConnectorConfig> = {
  type: 'github',
  pollMode: 'incremental',

  async build(cfg, ctx): Promise<BuildResult> {
    // Per-connector override wins over the global App; absence of both surfaces
    // as a structured failure (no auth attempt, no misleading 401 from GitHub).
    const resolved = resolveAppCredentials(cfg, ctx.globalApp);
    if (!resolved.id || !resolved.privateKeyPath) {
      return {
        ok: false,
        code: 'APP_NOT_CONFIGURED',
        message: resolved.overridden
          ? `Connector ${cfg.id} overrides the GitHub App but is missing app.id or app.privateKeyPath.`
          : `No GitHub App configured. Set GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY_PATH or set connector.app on each instance.`,
      };
    }
    let privateKey: string;
    try {
      privateKey = ctx.readPrivateKey(resolved.privateKeyPath);
    } catch (err) {
      return {
        ok: false,
        code: 'PRIVATE_KEY_UNREADABLE',
        message: `Cannot read App private key at ${resolved.privateKeyPath}: ${(err as Error).message}`,
      };
    }
    return {
      ok: true,
      connector: new GitHubConnector(),
      sdkConfig: {
        id: cfg.id,
        type: 'github',
        credentials: { appId: resolved.id, privateKey, installationId: cfg.installationId },
        scope: { org: cfg.org },
      },
    };
  },
};
```

`packages/api-server/src/services/connector-types/index.ts`:

```ts
import type { ConnectorInstanceConfig } from '@shipit-ai/shared';
import { githubConnectorType } from './github.js';
import type { ConnectorType } from './types.js';

export type {
  BuildContext,
  BuildResult,
  BuiltConnector,
  ConnectorType,
  ProbeResult,
} from './types.js';

// Every connector kind the api-server can run. Adding a connector = adding a
// module here; the scheduler, registry and routes dispatch through this table.
// `ConnectorType<Specific>` is not assignable to `ConnectorType<Union>` (build's
// parameter is contravariant), so entries are widened once, here.
export const CONNECTOR_TYPES: Readonly<Record<string, ConnectorType>> = {
  github: githubConnectorType as unknown as ConnectorType,
};

export function getConnectorType(type: string): ConnectorType | undefined {
  return CONNECTOR_TYPES[type];
}

export function connectorTypeFor(cfg: ConnectorInstanceConfig): ConnectorType {
  const type = CONNECTOR_TYPES[cfg.type];
  if (!type) throw new Error(`No connector type registered for "${cfg.type}"`);
  return type;
}
```

- [ ] **Step 4: Run the factory test**

Run: `cd packages/api-server && npx vitest run src/__tests__/services/connector-types.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing scheduler tests**

In `packages/api-server/src/__tests__/services/sync-scheduler.test.ts`:

1. Change the `Worker` mock to capture the processor (mirrors the event-bus test):
   ```ts
   let capturedProcessor:
     ((job: { data: unknown; log: (s: string) => void }) => Promise<void>) | null = null;
   // inside vi.mock('bullmq', ...):
   const Worker = vi.fn().mockImplementation(function (
     _name: string,
     processor: (job: { data: unknown; log: (s: string) => void }) => Promise<void>,
   ) {
     capturedProcessor = processor;
     return { on: mockWorkerOn, close: mockWorkerClose };
   });
   ```
2. Mock the connector-type table at the top of the file (after the bullmq mock):
   ```ts
   const fakeBuild = vi.fn();
   vi.mock('../../services/connector-types/index.js', () => ({
     getConnectorType: (type: string) =>
       type === 'github'
         ? { type: 'github', pollMode: 'incremental', build: fakeBuild }
         : type === 'fullpoll'
           ? { type: 'fullpoll', pollMode: 'full', build: fakeBuild }
           : undefined,
     connectorTypeFor: (cfg: { type: string }) => ({
       type: cfg.type,
       pollMode: cfg.type === 'fullpoll' ? 'full' : 'incremental',
       build: fakeBuild,
     }),
   }));
   ```
3. Replace `makeScheduler()` with one that accepts fakes:
   ```ts
   function makeScheduler(overrides: Partial<ConstructorParameters<typeof SyncScheduler>[0]> = {}) {
     return new SyncScheduler({
       redisUrl: 'redis://localhost:6379',
       registry: {
         get: vi.fn(),
         recordRun: vi.fn().mockResolvedValue(undefined),
         list: () => [],
       } as never,
       eventBus: {
         publish: vi.fn().mockResolvedValue(undefined),
         publishControl: vi.fn().mockResolvedValue(undefined),
       } as never,
       globalApp: { id: '', privateKeyPath: '' },
       ...overrides,
     });
   }
   function fakeConnector(warnings: string[] = []) {
     return {
       manifest: {
         name: 'fake',
         version: '1',
         schema_version: '1',
         min_sdk_version: '0',
         supported_entity_types: [],
       },
       authenticate: vi.fn().mockResolvedValue({ success: true }),
       discover: vi.fn().mockResolvedValue({ entity_types: [], total_entities: {} }),
       fetch: vi.fn(),
       normalize: vi.fn(),
       sync: vi.fn(),
       getWarnings: () => warnings,
     };
   }
   ```
4. Append tests:
   ```ts
   describe('SyncScheduler — connector types', () => {
     beforeEach(() => {
       vi.clearAllMocks();
       capturedProcessor = null;
     });

     it("enqueues the repeat job with the type's pollMode", async () => {
       const scheduler = makeScheduler();
       await scheduler.start({
         id: 'k',
         type: 'fullpoll',
         enabled: true,
         schedule: '*/5 * * * *',
       } as never);
       expect(mockQueueAdd).toHaveBeenCalledWith(
         'poll:k',
         { connectorId: 'k', mode: 'full' },
         { repeat: { pattern: '*/5 * * * *' } },
       );
     });

     it('publishes sync.completed only after a successful FULL run', async () => {
       const registry = {
         get: vi.fn().mockReturnValue({ id: 'k', type: 'fullpoll' }),
         recordRun: vi.fn().mockResolvedValue(undefined),
         list: () => [],
       };
       const eventBus = {
         publish: vi.fn().mockResolvedValue(undefined),
         publishControl: vi.fn().mockResolvedValue(undefined),
       };
       makeScheduler({ registry: registry as never, eventBus: eventBus as never });
       fakeBuild.mockResolvedValue({
         ok: true,
         connector: fakeConnector(),
         sdkConfig: { id: 'k', type: 'fullpoll', credentials: {}, scope: {} },
       });

       await capturedProcessor!({ data: { connectorId: 'k', mode: 'full' }, log: () => undefined });
       expect(eventBus.publishControl).toHaveBeenCalledWith('k', {
         kind: 'sync.completed',
         startedAt: expect.stringMatching(/T/),
         mode: 'full',
       });
       expect(registry.recordRun).toHaveBeenCalledWith(
         'k',
         expect.objectContaining({ status: 'success' }),
       );

       eventBus.publishControl.mockClear();
       await capturedProcessor!({
         data: { connectorId: 'k', mode: 'incremental' },
         log: () => undefined,
       });
       expect(eventBus.publishControl).not.toHaveBeenCalled();
     });

     it('folds connector warnings into the run as partial and skips the sweep', async () => {
       const registry = {
         get: vi.fn().mockReturnValue({ id: 'k', type: 'fullpoll' }),
         recordRun: vi.fn().mockResolvedValue(undefined),
         list: () => [],
       };
       const eventBus = { publish: vi.fn(), publishControl: vi.fn() };
       const scheduler = makeScheduler({
         registry: registry as never,
         eventBus: eventBus as never,
       });
       fakeBuild.mockResolvedValue({
         ok: true,
         connector: fakeConnector(['FORBIDDEN:CronJob — denied']),
         sdkConfig: { id: 'k', type: 'fullpoll', credentials: {}, scope: {} },
       });

       await capturedProcessor!({ data: { connectorId: 'k', mode: 'full' }, log: () => undefined });
       expect(registry.recordRun).toHaveBeenCalledWith(
         'k',
         expect.objectContaining({ status: 'partial', errors: ['FORBIDDEN:CronJob — denied'] }),
       );
       expect(eventBus.publishControl).not.toHaveBeenCalled();
       expect(scheduler.getStatus('k')).toMatchObject({
         state: 'degraded',
         lastError: 'FORBIDDEN:CronJob — denied',
       });
     });

     it('records a build failure as a failed run without running the harness', async () => {
       const registry = {
         get: vi.fn().mockReturnValue({ id: 'gh', type: 'github' }),
         recordRun: vi.fn().mockResolvedValue(undefined),
         list: () => [],
       };
       const scheduler = makeScheduler({ registry: registry as never });
       fakeBuild.mockResolvedValue({
         ok: false,
         code: 'APP_NOT_CONFIGURED',
         message: 'No GitHub App configured.',
       });

       await capturedProcessor!({
         data: { connectorId: 'gh', mode: 'incremental' },
         log: () => undefined,
       });
       expect(registry.recordRun).toHaveBeenCalledWith(
         'gh',
         expect.objectContaining({ status: 'failed', errors: ['No GitHub App configured.'] }),
       );
       expect(scheduler.getStatus('gh')).toMatchObject({ state: 'failed' });
     });

     it('a sync.completed publish failure is logged, not thrown', async () => {
       const registry = {
         get: vi.fn().mockReturnValue({ id: 'k', type: 'fullpoll' }),
         recordRun: vi.fn().mockResolvedValue(undefined),
         list: () => [],
       };
       const eventBus = {
         publish: vi.fn(),
         publishControl: vi.fn().mockRejectedValue(new Error('OOM')),
       };
       makeScheduler({ registry: registry as never, eventBus: eventBus as never });
       fakeBuild.mockResolvedValue({
         ok: true,
         connector: fakeConnector(),
         sdkConfig: { id: 'k', type: 'fullpoll', credentials: {}, scope: {} },
       });
       const log = vi.fn();
       await expect(
         capturedProcessor!({ data: { connectorId: 'k', mode: 'full' }, log }),
       ).resolves.toBeUndefined();
       expect(log).toHaveBeenCalledWith(expect.stringContaining('sync.completed'));
     });
   });
   ```

- [ ] **Step 6: Run to verify they fail**

Run: `cd packages/api-server && npx vitest run src/__tests__/services/sync-scheduler.test.ts`
Expected: the new cases FAIL (`mode: 'incremental'` enqueued for `fullpoll`; processor still GitHub-specific).

- [ ] **Step 7: Rewrite the scheduler onto the factory**

In `packages/api-server/src/services/sync-scheduler.ts`:

Imports — drop `GitHubConnector` and `resolveAppCredentials`/`GitHubConnectorConfig`; add:

```ts
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { Queue, Worker, type ConnectionOptions, type Job } from 'bullmq';
import { authenticateGitHubApp } from '@shipit-ai/connector-github';
import { ConnectorHarness } from '@shipit-ai/connector-sdk';
import { COMPLETED_JOB_RETENTION, FAILED_JOB_RETENTION } from '@shipit-ai/event-bus';
import type { AppLike, ConnectorInstanceConfig, EventBusClient } from '@shipit-ai/shared';
import { getConnectorType } from './connector-types/index.js';
import type { BuildContext } from './connector-types/types.js';
import type {
  ConnectorRegistry,
  ConnectorRunner,
  SyncRuntimeStatus,
} from './connector-registry.js';
```

Options — add after `queueName?`:

```ts
  // Absolute key directory credential files live in. Defaults to
  // SHIPIT_GITHUB_APP_KEY_DIR / ~/.shipit/keys like the routes.
  keyDir?: string;
  // Graph lookups for the Kubernetes linking tiers (Task 11). Optional.
  lookupRepositoryNames?: (org: string) => Promise<string[]>;
  lookupTeamSlugs?: (org: string) => Promise<string[]>;
```

Fields + constructor — add `private readonly buildContext: BuildContext;` and in the constructor (after `this.globalApp = opts.globalApp;`):

```ts
const keyDir = resolvePath(
  opts.keyDir ?? process.env.SHIPIT_GITHUB_APP_KEY_DIR ?? `${homedir()}/.shipit/keys`,
);
this.buildContext = {
  globalApp: this.globalApp,
  readPrivateKey: (path) => this.readPrivateKey(path),
  keyDir,
  lookupRepositoryNames: opts.lookupRepositoryNames,
  lookupTeamSlugs: opts.lookupTeamSlugs,
  listConnectors: () => this.registry.list(),
};
```

`start` / `triggerSync` signatures become `connector: ConnectorInstanceConfig`; `start` enqueues the type's poll mode:

```ts
  async start(connector: ConnectorInstanceConfig): Promise<void> {
    if (!connector.enabled) return;
    const mode = getConnectorType(connector.type)?.pollMode ?? 'incremental';
    await this.queue.add(
      `poll:${connector.id}`,
      { connectorId: connector.id, mode },
      { repeat: { pattern: connector.schedule } },
    );
    if (!this.statuses.has(connector.id)) {
      this.statuses.set(connector.id, { connectorId: connector.id, state: 'idle' });
    }
  }
```

Replace `processJob` entirely:

```ts
  private async failRun(connectorId: string, startedAt: string, startTime: number, message: string): Promise<void> {
    await this.registry.recordRun(connectorId, {
      startedAt,
      durationMs: Date.now() - startTime,
      status: 'failed',
      entitiesSynced: 0,
      errors: [message],
    });
    this.statuses.set(connectorId, { connectorId, state: 'failed', startedAt, lastError: message });
  }

  // ── Job processor ────────────────────────────────────────────────────
  // Resolves the connector type, builds a per-job connector + harness, runs the
  // sync, writes the run back, and — for a successful FULL run — publishes the
  // sync.completed control envelope that drives the core-writer absence sweep.
  private async processJob(job: Job<SyncJobData>): Promise<void> {
    const startTime = Date.now();
    const startedAt = new Date(startTime).toISOString();
    const { connectorId, mode } = job.data;
    let cfg: ConnectorInstanceConfig;
    try {
      cfg = this.registry.get(connectorId);
    } catch (err) {
      // Connector was deleted while a job was still queued — drop the run
      // silently. Recording status would resurrect a no-longer-extant id.
      job.log(`connector ${connectorId} no longer exists: ${(err as Error).message}`);
      return;
    }

    this.statuses.set(connectorId, { connectorId, state: 'running', startedAt });

    const type = getConnectorType(cfg.type);
    if (!type) {
      await this.failRun(connectorId, startedAt, startTime, `No connector type registered for "${cfg.type}"`);
      return;
    }
    const built = await type.build(cfg, this.buildContext);
    if (!built.ok) {
      await this.failRun(connectorId, startedAt, startTime, built.message);
      return;
    }

    const harness = new ConnectorHarness(built.connector, this.eventBus, built.sdkConfig);
    const result = await harness.runSync(mode);

    // Non-fatal connector warnings (e.g. a kind the ServiceAccount may not
    // list) make the run `partial`: something was skipped, so the absence
    // sweep below must NOT run — it would mark the skipped kind absent.
    const warnings = built.connector.getWarnings?.() ?? [];
    if (warnings.length > 0) {
      result.errors.push(...warnings);
      if (result.status === 'success') result.status = 'partial';
    }

    // Persist the outcome to the registry's history (cap 20). Best-effort —
    // a write failure shouldn't take down the worker.
    try {
      await this.registry.recordRun(connectorId, {
        startedAt,
        durationMs: result.duration_ms,
        status: result.status,
        entitiesSynced: result.entities_synced,
        errors: result.errors,
      });
    } catch (err) {
      job.log(`failed to persist run history: ${(err as Error).message}`);
    }

    if (result.status === 'success' && mode === 'full') {
      try {
        await this.eventBus.publishControl(connectorId, { kind: 'sync.completed', startedAt, mode });
      } catch (err) {
        job.log(`failed to publish sync.completed for ${connectorId}: ${(err as Error).message}`);
      }
    }

    // 401/403 are sticky — surface as "degraded" so the UI flags the
    // connector instead of letting the next polling tick repeat the
    // failure silently. (Structured boolean from the harness, not a
    // string match — see the old comment history for why.)
    const authFailed = result.authFailed === true;
    this.statuses.set(connectorId, {
      connectorId,
      startedAt,
      state:
        result.status === 'success'
          ? 'idle'
          : authFailed
            ? 'degraded'
            : result.status === 'partial'
              ? 'degraded'
              : 'failed',
      lastError: result.errors[0],
    });
  }
```

Keep `readPrivateKey` (memoized) and `probeAppCredentials` unchanged.

- [ ] **Step 8: Generalize the registry**

In `packages/api-server/src/services/connector-registry.ts`:

- Imports: add `KubernetesConnectorConfig` to the shared type import.
- `ConnectorRunner` and `NoopRunner`: every `GitHubConnectorConfig` parameter becomes `ConnectorInstanceConfig`.
- Replace `CreateConnectorInput` / `UpdateConnectorInput` (export both):

```ts
export type CreateConnectorInput =
  | {
      type: 'github';
      id: string;
      name: string;
      enabled?: boolean;
      installationId: string;
      org: string;
      schedule?: string;
      scope?: GitHubConnectorConfig['scope'];
      entities?: GitHubConnectorConfig['entities'];
      // Optional per-connector GitHub App override; absent → inherits global.
      app?: GitHubConnectorConfig['app'];
    }
  | {
      type: 'kubernetes';
      id: string;
      name: string;
      enabled?: boolean;
      schedule?: string;
      cluster: KubernetesConnectorConfig['cluster'];
      access: KubernetesConnectorConfig['access'];
      scope?: KubernetesConnectorConfig['scope'];
      mapping?: KubernetesConnectorConfig['mapping'];
    };

export interface UpdateConnectorInput {
  enabled?: boolean;
  name?: string;
  schedule?: string;
  // Per-type blocks; the registry re-validates the merged object with Zod, so a
  // block that does not belong to the instance's type is stripped, not applied.
  scope?: unknown;
  entities?: unknown;
  cluster?: unknown;
  access?: unknown;
  mapping?: unknown;
  // Explicit `null` clears an existing GitHub App override; `undefined` leaves it alone.
  app?: GitHubConnectorConfig['app'] | null;
}
```

- `create()` body:

```ts
const base = {
  id: input.id,
  name: input.name,
  enabled: input.enabled ?? true,
  lastRuns: [] as LastRun[],
  ...(input.schedule !== undefined ? { schedule: input.schedule } : {}),
};
// Zod fills every omitted block with the same defaults the loader uses, so
// runtime creation and boot-time validation cannot drift.
const candidate =
  input.type === 'github'
    ? {
        ...base,
        type: 'github' as const,
        installationId: input.installationId,
        org: input.org,
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
        ...(input.entities !== undefined ? { entities: input.entities } : {}),
        ...(input.app ? { app: input.app } : {}),
      }
    : {
        ...base,
        type: 'kubernetes' as const,
        cluster: input.cluster,
        access: input.access,
        ...(input.scope !== undefined ? { scope: input.scope } : {}),
        ...(input.mapping !== undefined ? { mapping: input.mapping } : {}),
      };
const parsed = parseConnectorInstance(candidate);

this.connectors.set(parsed.id, parsed);
await this.persist();
if (parsed.enabled) await this.runner.start(parsed);
return parsed;
```

- `update()` merge:

```ts
const patch: Record<string, unknown> = {};
for (const key of [
  'enabled',
  'name',
  'schedule',
  'scope',
  'entities',
  'cluster',
  'access',
  'mapping',
] as const) {
  if (input[key] !== undefined) patch[key] = input[key];
}
if (existing.type === 'github') {
  // `app: null` clears an existing override; `app: {...}` replaces it; `app: undefined` leaves it alone.
  patch.app = input.app === null ? undefined : input.app !== undefined ? input.app : existing.app;
}
const next = parseConnectorInstance({ ...existing, ...patch });
```

- `startRunner`: `await this.runner.start(connector);` (drop the cast). Same in `update()`: `await this.runner.start(next);`.

Extend `packages/api-server/src/__tests__/services/connector-registry.test.ts` with:

```ts
describe('ConnectorRegistry — kubernetes instances', () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shipit-registry-k8s-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a kubernetes instance with defaults, persists it and starts the runner with it', async () => {
    const started: ConnectorInstanceConfig[] = [];
    const runner: ConnectorRunner = {
      start: async (c) => {
        started.push(c);
      },
      stop: async () => undefined,
      triggerSync: async (c) => ({ connectorId: c.id, state: 'idle' }),
      getStatus: (id) => ({ connectorId: id, state: 'idle' }),
    };
    const registry = new ConnectorRegistry({
      localConfigPath: join(tmpDir, 'shipit.config.local.yaml'),
      initial: [],
      runner,
    });
    const created = await registry.create({
      type: 'kubernetes',
      id: 'k8s-demo',
      name: 'Demo',
      cluster: { name: 'shipit-demo' },
      access: { mode: 'in-cluster' },
    });
    expect(created.type).toBe('kubernetes');
    if (created.type !== 'kubernetes') throw new Error('unreachable');
    expect(created.schedule).toBe('*/5 * * * *');
    expect(created.scope.kinds).toEqual(['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob']);
    expect(started.map((c) => c.id)).toEqual(['k8s-demo']);
    const yaml = parseYaml(readFileSync(join(tmpDir, 'shipit.config.local.yaml'), 'utf-8')) as {
      connectors: { instances: Array<{ id: string; type: string }> };
    };
    expect(yaml.connectors.instances).toEqual([
      expect.objectContaining({ id: 'k8s-demo', type: 'kubernetes' }),
    ]);
  });

  it('update merges the mapping block and strips blocks of the other type', async () => {
    const registry = new ConnectorRegistry({
      localConfigPath: join(tmpDir, 'shipit.config.local.yaml'),
      initial: [],
    });
    await registry.create({
      type: 'kubernetes',
      id: 'k8s-demo',
      name: 'Demo',
      cluster: { name: 'shipit-demo' },
      access: { mode: 'in-cluster' },
    });
    const updated = await registry.update(
      'k8s-demo',
      { mapping: { repoLink: { githubOrg: 'Ship-It-Ops' } }, entities: { repository: false } },
      undefined,
    );
    if (updated.type !== 'kubernetes') throw new Error('unreachable');
    expect(updated.mapping.repoLink).toEqual({
      annotation: 'shipit.ai/github-repo',
      githubOrg: 'Ship-It-Ops',
      nameMatch: true,
    });
    expect(updated).not.toHaveProperty('entities');
  });
});
```

- [ ] **Step 9: Wire the new options through boot**

`packages/api-server/src/services/sync-runtime.ts` — add to `WireSyncRuntimeOptions`:

```ts
  keyDir?: string;
  lookupRepositoryNames?: (org: string) => Promise<string[]>;
  lookupTeamSlugs?: (org: string) => Promise<string[]>;
```

and pass them into `createScheduler({ redisUrl, registry, eventBus, globalApp, concurrency, keyDir: opts.keyDir, lookupRepositoryNames: opts.lookupRepositoryNames, lookupTeamSlugs: opts.lookupTeamSlugs })`.

`packages/api-server/src/index.ts` — extend the `wireSyncRuntime({...})` call:

```ts
    keyDir: process.env.SHIPIT_GITHUB_APP_KEY_DIR,
    // Kubernetes linking tiers compare against what GitHub already wrote, with
    // the source's casing. `_source_org` is `github/<org>` on every GitHub node.
    lookupRepositoryNames: async (org) =>
      (
        await neo4jService.runQuery(
          'MATCH (r:Repository) WHERE r._source_org = $org RETURN r.name AS name',
          { org: `github/${org}` },
        )
      ).map((r) => String(r.get('name'))),
    lookupTeamSlugs: async (org) =>
      (
        await neo4jService.runQuery('MATCH (t:Team) WHERE t._source_org = $org RETURN t.slug AS slug', {
          org: `github/${org}`,
        })
      ).map((r) => String(r.get('slug'))),
```

- [ ] **Step 10: Route type guards (no new behavior)**

In `packages/api-server/src/routes/connectors.ts`:

- `GET /github/installations` usedBy loop: `if (c.type === 'github' && c.installationId) usedBy.set(c.installationId, c.id);`
- `POST /`: keep the existing `body.type !== 'github'` rejection for now (Task 11 opens it) but pass `type: 'github' as const` into `registry.create({...})` unchanged — the call already matches the github union member.
- `PATCH /:id`: pass the body fields straight through (the `UpdateConnectorInput` now accepts `cluster`/`access`/`mapping` but the route does not read them until Task 11).
- Anywhere the file (or `settings-service.ts` / `index.ts`) narrowed with `as GitHubConnectorConfig` after a `type !== 'github'` check, leave it; where it narrowed without a check, add `if (c.type !== 'github') continue;` (or `return`) first. The boot-time webhook-secret loop in `index.ts` already skips non-github.

- [ ] **Step 11: Run the whole api-server suite + typecheck**

Run: `cd packages/api-server && npx tsc --noEmit && npx vitest run`
Expected: PASS — all previous GitHub tests (routes, registry, scheduler, sync-runtime, webhook refetch) plus the new ones. `test:integration` is unaffected.

- [ ] **Step 12: Commit**

```bash
git add packages/api-server/src
git commit -m "api-server: connector-type factory; scheduler/registry generic over connector type; sync.completed emission"
```

---

### Task 11: Kubernetes connector type, credentials route, probe, blob durability, boot wiring

Implements spec §Credentials, §Connector-type factory (kubernetes), §Error handling (probe codes), §Safety (path allowlist).

**Files:**

- Modify: `packages/api-server/package.json` — add `"@shipit-ai/connector-kubernetes": "workspace:*"` under `dependencies`, then `pnpm install` (workspace link only; lockfile updates, no new external packages).
- Create: `packages/api-server/src/services/connector-types/kubernetes.ts`
- Modify: `packages/api-server/src/services/connector-types/index.ts` (register)
- Modify: `packages/api-server/src/services/connector-app-store.ts`
- Modify: `packages/api-server/src/routes/connectors.ts`
- Test: `packages/api-server/src/__tests__/services/connector-types-kubernetes.test.ts` (create)
- Test: `packages/api-server/src/__tests__/services/connector-app-store.test.ts` (extend)
- Test: `packages/api-server/src/__tests__/routes/connectors.test.ts` (extend)

**Interfaces:**

- Consumes: Task 9 (`KubernetesConnector`, `buildKubeConfig`, `classifyError`, `validateKubeconfigText`, `fetchNamespaces`, `WorkloadFetcher`, `withTimeout`, `defaultClientFactory`), Task 10 (`ConnectorType`, `BuildContext`, `CreateConnectorInput`).
- Produces: `makeKubernetesConnectorType(clientFactory?)`, `kubernetesConnectorType` (registered as `CONNECTOR_TYPES.kubernetes`, `pollMode: 'full'`), `credentialsFromAccess(access, keyDir)`, `resolveGithubOrg(cfg, connectors)`; HTTP: `POST /api/connectors` accepts `type: 'kubernetes'`; `POST /api/connectors/kubernetes/credentials`; `POST /api/connectors/probe` accepts `type: 'kubernetes'`; `BlobRecord.kubeconfig? / k8sToken? / k8sCa?`.

- [ ] **Step 1: Write the failing type tests**

Create `packages/api-server/src/__tests__/services/connector-types-kubernetes.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApiException } from '@kubernetes/client-node';
import { connectorInstanceSchema, type KubernetesConnectorConfig } from '@shipit-ai/shared';
import type { KubeClients } from '@shipit-ai/connector-kubernetes';
import {
  makeKubernetesConnectorType,
  resolveGithubOrg,
  credentialsFromAccess,
} from '../../services/connector-types/kubernetes.js';
import { getConnectorType } from '../../services/connector-types/index.js';
import type { BuildContext } from '../../services/connector-types/types.js';

const list = (items: unknown[]) => ({ items, metadata: {} });
function fakeClients(overrides: Partial<Record<keyof KubeClients, unknown>> = {}): KubeClients {
  return {
    version: { getCode: vi.fn().mockResolvedValue({ gitVersion: 'v1.31.2' }) },
    core: {
      listNamespace: vi
        .fn()
        .mockResolvedValue(
          list([{ metadata: { name: 'shipit' } }, { metadata: { name: 'kube-system' } }]),
        ),
      readNamespace: vi.fn(),
      listNode: vi.fn().mockResolvedValue(list([])),
      listNamespacedPod: vi.fn().mockResolvedValue(list([])),
    },
    apps: {
      listNamespacedDeployment: vi.fn().mockResolvedValue(list([])),
      listNamespacedStatefulSet: vi.fn().mockResolvedValue(list([])),
      listNamespacedDaemonSet: vi.fn().mockResolvedValue(list([])),
      listNamespacedReplicaSet: vi.fn().mockResolvedValue(list([])),
    },
    batch: {
      listNamespacedCronJob: vi
        .fn()
        .mockRejectedValue(new ApiException(403, 'cronjobs is forbidden', {}, {})),
    },
    ...overrides,
  } as unknown as KubeClients;
}

const k8s = (access: Record<string, unknown>, mapping: Record<string, unknown> = {}) =>
  connectorInstanceSchema.parse({
    id: 'k8s-demo',
    type: 'kubernetes',
    name: 'Demo',
    cluster: { name: 'shipit-demo' },
    access,
    mapping,
  }) as KubernetesConnectorConfig;
const gh = (id: string, org: string, enabled = true) =>
  connectorInstanceSchema.parse({
    id,
    type: 'github',
    name: id,
    installationId: '1',
    org,
    enabled,
  });

describe('kubernetes connector type', () => {
  let keyDir: string;
  beforeEach(() => {
    keyDir = mkdtempSync(join(tmpdir(), 'shipit-k8s-type-'));
  });
  afterEach(() => {
    rmSync(keyDir, { recursive: true, force: true });
  });

  function ctx(overrides: Partial<BuildContext> = {}): BuildContext {
    return {
      globalApp: { id: '', privateKeyPath: '' },
      readPrivateKey: () => '',
      keyDir,
      listConnectors: () => [],
      ...overrides,
    };
  }

  it('is registered with pollMode full', () => {
    expect(getConnectorType('kubernetes')?.pollMode).toBe('full');
  });

  it('credentialsFromAccess reads files pinned to the key dir by basename and base64-encodes the CA', () => {
    writeFileSync(join(keyDir, 'k8s-token-demo'), 'tok\n');
    writeFileSync(
      join(keyDir, 'k8s-ca-demo.pem'),
      '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n',
    );
    const creds = credentialsFromAccess(
      {
        mode: 'token',
        server: 'https://h',
        tokenPath: '/elsewhere/../k8s-token-demo',
        caDataPath: '/tmp/k8s-ca-demo.pem',
      },
      keyDir,
    );
    expect(creds).toEqual({
      mode: 'token',
      server: 'https://h',
      token: 'tok',
      caData: Buffer.from('-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n').toString(
        'base64',
      ),
    });
    expect(credentialsFromAccess({ mode: 'in-cluster' }, keyDir)).toEqual({ mode: 'in-cluster' });
  });

  it('resolveGithubOrg prefers mapping.repoLink.githubOrg, else the sole enabled GitHub connector', () => {
    expect(
      resolveGithubOrg(k8s({ mode: 'in-cluster' }, { repoLink: { githubOrg: 'Pinned' } }), [
        gh('a', 'acme'),
      ]),
    ).toBe('Pinned');
    expect(resolveGithubOrg(k8s({ mode: 'in-cluster' }), [gh('a', 'acme'), gh('b', 'acme')])).toBe(
      'acme',
    );
    expect(
      resolveGithubOrg(k8s({ mode: 'in-cluster' }), [gh('a', 'acme'), gh('b', 'other')]),
    ).toBeNull();
    expect(resolveGithubOrg(k8s({ mode: 'in-cluster' }), [gh('a', 'acme', false)])).toBeNull();
    expect(resolveGithubOrg(k8s({ mode: 'in-cluster' }), [])).toBeNull();
  });

  it('build feeds credentials, scope and graph lookups into the sdk config', async () => {
    writeFileSync(join(keyDir, 'kubeconfig-k8s-demo.yaml'), 'apiVersion: v1');
    const type = makeKubernetesConnectorType(() => fakeClients());
    const built = await type.build(
      k8s({
        mode: 'kubeconfig',
        kubeconfigPath: join(keyDir, 'kubeconfig-k8s-demo.yaml'),
        context: 'demo',
      }),
      ctx({
        listConnectors: () => [gh('a', 'Ship-It-Ops')],
        lookupRepositoryNames: async (org) => (org === 'Ship-It-Ops' ? ['ShipIt-AI'] : []),
        lookupTeamSlugs: async () => ['platform-team'],
      }),
    );
    if (!built.ok) throw new Error(built.message);
    expect(built.connector.manifest.name).toBe('kubernetes');
    expect(built.sdkConfig.credentials).toEqual({
      mode: 'kubeconfig',
      kubeconfig: 'apiVersion: v1',
      context: 'demo',
    });
    expect(built.sdkConfig.scope).toMatchObject({
      cluster: 'shipit-demo',
      kinds: ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob'],
      githubOrg: 'Ship-It-Ops',
      knownRepositories: ['ShipIt-AI'],
      knownTeams: ['platform-team'],
    });
  });

  it('build reports unreadable credential files structurally and tolerates lookup failures', async () => {
    const type = makeKubernetesConnectorType(() => fakeClients());
    const missing = await type.build(
      k8s({ mode: 'token', server: 'https://h', tokenPath: join(keyDir, 'nope') }),
      ctx(),
    );
    expect(missing).toMatchObject({ ok: false, code: 'CREDENTIALS_UNREADABLE' });
    const built = await type.build(
      k8s({ mode: 'in-cluster' }),
      ctx({
        listConnectors: () => [gh('a', 'acme')],
        lookupRepositoryNames: async () => {
          throw new Error('neo4j down');
        },
      }),
    );
    if (!built.ok) throw new Error(built.message);
    expect(built.sdkConfig.scope).toMatchObject({
      githubOrg: 'acme',
      knownRepositories: [],
      knownTeams: [],
    });
  });

  it('probe returns version, scoped namespaces and per-kind access', async () => {
    const type = makeKubernetesConnectorType(() => fakeClients());
    const r = await type.probe!(
      { type: 'kubernetes', access: { mode: 'token', server: 'https://h', token: 't' } },
      ctx(),
    );
    expect(r).toEqual({
      ok: true,
      cluster: { version: 'v1.31.2' },
      namespaces: ['shipit'],
      kinds: { Deployment: 'ok', StatefulSet: 'ok', DaemonSet: 'ok', CronJob: 'forbidden' },
    });
  });

  it('probe maps failures to structured codes', async () => {
    const unauthorized = makeKubernetesConnectorType(() =>
      fakeClients({
        version: { getCode: vi.fn().mockRejectedValue(new ApiException(401, 'x', {}, {})) },
      }),
    );
    expect(
      await unauthorized.probe!(
        { type: 'kubernetes', access: { mode: 'token', server: 'https://h', token: 't' } },
        ctx(),
      ),
    ).toMatchObject({ ok: false, code: 'UNAUTHORIZED' });
    const noCluster = makeKubernetesConnectorType(() => fakeClients());
    expect(
      await noCluster.probe!({ type: 'kubernetes', access: { mode: 'in-cluster' } }, ctx()),
    ).toMatchObject({ ok: false, code: 'IN_CLUSTER_UNAVAILABLE' });
    const badPath = await noCluster.probe!(
      {
        type: 'kubernetes',
        access: { mode: 'kubeconfig', kubeconfigPath: join(keyDir, 'missing.yaml') },
      },
      ctx(),
    );
    expect(badPath).toMatchObject({ ok: false, code: 'CREDENTIALS_UNREADABLE' });
  });
});
```

(`noCluster` relies on the test process not running inside a pod: `KUBERNETES_SERVICE_HOST` is unset on dev machines and in CI.)

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/api-server && npx vitest run src/__tests__/services/connector-types-kubernetes.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `connector-types/kubernetes.ts` and register it**

```ts
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  KubernetesConnector,
  WorkloadFetcher,
  buildKubeConfig,
  classifyError,
  defaultClientFactory,
  fetchNamespaces,
  withTimeout,
  type ClientFactory,
  type KubeClients,
  type KubernetesAccessCredentials,
} from '@shipit-ai/connector-kubernetes';
import {
  KUBERNETES_WORKLOAD_KINDS,
  type ConnectorInstanceConfig,
  type KubernetesConnectorConfig,
  type KubernetesWorkloadKind,
} from '@shipit-ai/shared';
import type { BuildContext, BuildResult, ConnectorType, ProbeResult } from './types.js';

const PROBE_TIMEOUT_MS = 30_000;

// Pinned read — basename() over the trusted key dir. The route layer already
// rejected paths outside the dir (isAllowedKeyPath); this keeps the sink safe
// even if a stored config was hand-edited.
function readKeyFile(keyDir: string, configuredPath: string): string {
  return readFileSync(join(keyDir, basename(configuredPath)), 'utf-8');
}

/** Stored `access` block → the `ConnectorConfig.credentials` map the connector parses. */
export function credentialsFromAccess(
  access: KubernetesConnectorConfig['access'],
  keyDir: string,
): Record<string, string> {
  switch (access.mode) {
    case 'in-cluster':
      return { mode: 'in-cluster' };
    case 'kubeconfig':
      return {
        mode: 'kubeconfig',
        kubeconfig: readKeyFile(keyDir, access.kubeconfigPath),
        ...(access.context ? { context: access.context } : {}),
      };
    case 'token':
      return {
        mode: 'token',
        server: access.server,
        token: readKeyFile(keyDir, access.tokenPath).trim(),
        ...(access.caDataPath
          ? {
              caData: Buffer.from(readKeyFile(keyDir, access.caDataPath), 'utf-8').toString(
                'base64',
              ),
            }
          : {}),
      };
  }
}

/** Spec §Repository linking tiers: explicit org, else the sole enabled GitHub connector's org, else null. */
export function resolveGithubOrg(
  cfg: KubernetesConnectorConfig,
  connectors: ConnectorInstanceConfig[],
): string | null {
  if (cfg.mapping.repoLink.githubOrg) return cfg.mapping.repoLink.githubOrg;
  const orgs = new Set<string>();
  for (const c of connectors) if (c.type === 'github' && c.enabled) orgs.add(c.org);
  return orgs.size === 1 ? [...orgs][0] : null;
}

export interface KubernetesProbeBody {
  type: 'kubernetes';
  access:
    | { mode: 'in-cluster' }
    | { mode: 'kubeconfig'; kubeconfig?: string; kubeconfigPath?: string; context?: string }
    | {
        mode: 'token';
        server: string;
        token?: string;
        tokenPath?: string;
        caData?: string;
        caDataPath?: string;
      };
  namespaces?: { include?: string[]; exclude?: string[] };
  kinds?: KubernetesWorkloadKind[];
}

// Inline values win; a *Path falls back to the pinned key-dir read. `caData`
// is PEM text in both cases (the credentials route stores PEM); the connector
// wants base64.
function probeCredentials(
  access: KubernetesProbeBody['access'],
  keyDir: string,
): KubernetesAccessCredentials {
  switch (access.mode) {
    case 'in-cluster':
      return { mode: 'in-cluster' };
    case 'kubeconfig': {
      const text =
        access.kubeconfig ??
        (access.kubeconfigPath ? readKeyFile(keyDir, access.kubeconfigPath) : undefined);
      if (!text) throw new Error('kubeconfig or kubeconfigPath is required for mode kubeconfig');
      return { mode: 'kubeconfig', kubeconfig: text, context: access.context || undefined };
    }
    case 'token': {
      const token =
        access.token ??
        (access.tokenPath ? readKeyFile(keyDir, access.tokenPath).trim() : undefined);
      if (!access.server || !token)
        throw new Error('server and token (or tokenPath) are required for mode token');
      const caPem =
        access.caData ?? (access.caDataPath ? readKeyFile(keyDir, access.caDataPath) : undefined);
      return {
        mode: 'token',
        server: access.server,
        token,
        caData: caPem ? Buffer.from(caPem, 'utf-8').toString('base64') : undefined,
      };
    }
    default:
      throw new Error(`unknown access mode "${(access as { mode?: string }).mode ?? ''}"`);
  }
}

async function probeKubernetes(
  body: KubernetesProbeBody,
  ctx: BuildContext,
  clientFactory: ClientFactory,
): Promise<ProbeResult> {
  let creds: KubernetesAccessCredentials;
  try {
    creds = probeCredentials(body.access, ctx.keyDir);
  } catch (err) {
    return { ok: false, code: 'CREDENTIALS_UNREADABLE', message: (err as Error).message };
  }
  let clients: KubeClients;
  let version: string;
  try {
    clients = clientFactory(buildKubeConfig(creds));
    version = (await withTimeout(clients.version.getCode(), PROBE_TIMEOUT_MS, 'GET /version'))
      .gitVersion;
  } catch (err) {
    const e = classifyError(err);
    return { ok: false, code: e.code, message: e.message };
  }
  const include = body.namespaces?.include?.length ? body.namespaces.include : ['*'];
  const exclude = body.namespaces?.exclude ?? ['kube-system', 'kube-public', 'kube-node-lease'];
  let namespaces: string[];
  try {
    namespaces = (
      await fetchNamespaces(clients, { include, exclude }, undefined, PROBE_TIMEOUT_MS)
    ).refs.map((r) => r.name);
  } catch (err) {
    const e = classifyError(err);
    return { ok: false, code: e.code, message: e.message };
  }
  const kinds = body.kinds?.length ? body.kinds : [...KUBERNETES_WORKLOAD_KINDS];
  const kindStatus: Record<string, 'ok' | 'forbidden' | 'error' | 'skipped'> = {};
  const target = namespaces[0];
  for (const kind of kinds) {
    if (!target) {
      kindStatus[kind] = 'skipped';
      continue;
    }
    try {
      const fetcher = new WorkloadFetcher(
        clients,
        [{ name: target, labels: {}, annotations: {} }],
        [kind],
        PROBE_TIMEOUT_MS,
      );
      await fetcher.fetch();
      kindStatus[kind] = fetcher.warnings.length > 0 ? 'forbidden' : 'ok';
    } catch {
      kindStatus[kind] = 'error';
    }
  }
  return { ok: true, cluster: { version }, namespaces, kinds: kindStatus };
}

export function makeKubernetesConnectorType(
  clientFactory: ClientFactory = defaultClientFactory,
): ConnectorType<KubernetesConnectorConfig> {
  return {
    type: 'kubernetes',
    // Every run is a full list, so every successful poll drives the absence sweep.
    pollMode: 'full',

    async build(cfg, ctx): Promise<BuildResult> {
      let credentials: Record<string, string>;
      try {
        credentials = credentialsFromAccess(cfg.access, ctx.keyDir);
      } catch (err) {
        return {
          ok: false,
          code: 'CREDENTIALS_UNREADABLE',
          message: `Cannot read Kubernetes credentials for ${cfg.id} (${cfg.access.mode}): ${(err as Error).message}`,
        };
      }
      const githubOrg = resolveGithubOrg(cfg, ctx.listConnectors());
      let knownRepositories: string[] = [];
      let knownTeams: string[] = [];
      if (githubOrg) {
        // Lookups are best-effort: without them the name tiers simply do not match.
        try {
          [knownRepositories, knownTeams] = await Promise.all([
            ctx.lookupRepositoryNames?.(githubOrg) ?? Promise.resolve([]),
            ctx.lookupTeamSlugs?.(githubOrg) ?? Promise.resolve([]),
          ]);
        } catch (err) {
          console.warn(
            `kubernetes connector ${cfg.id}: graph lookups failed, name-match tiers disabled this run: ${(err as Error).message}`,
          );
          knownRepositories = [];
          knownTeams = [];
        }
      }
      return {
        ok: true,
        connector: new KubernetesConnector(clientFactory),
        sdkConfig: {
          id: cfg.id,
          type: 'kubernetes',
          credentials,
          scope: {
            cluster: cfg.cluster.name,
            namespaces: cfg.scope.namespaces,
            kinds: cfg.scope.kinds,
            mapping: cfg.mapping,
            githubOrg,
            knownRepositories,
            knownTeams,
          },
        },
      };
    },

    probe(body, ctx) {
      return probeKubernetes(body as KubernetesProbeBody, ctx, clientFactory);
    },
  };
}

export const kubernetesConnectorType = makeKubernetesConnectorType();
```

In `connector-types/index.ts` add `import { kubernetesConnectorType } from './kubernetes.js';` and the entry `kubernetes: kubernetesConnectorType as unknown as ConnectorType,`.

- [ ] **Step 4: Run the type tests**

Run: `cd packages/api-server && npx vitest run src/__tests__/services/connector-types-kubernetes.test.ts src/__tests__/services/connector-types.test.ts`
Expected: PASS. (Update the "knows github and nothing else yet" assertion in `connector-types.test.ts` to `expect(getConnectorType('kubernetes')?.pollMode).toBe('full')`.)

- [ ] **Step 5: Blob durability — failing test, then implementation**

Append to `packages/api-server/src/__tests__/services/connector-app-store.test.ts` (inside `describe('ConnectorAppStore')`, reusing `keyDir` and `fakeGsmStore`):

```ts
function k8sConnector(id: string, access: Record<string, unknown>): ConnectorInstanceConfig {
  return connectorInstanceSchema.parse({
    id,
    type: 'kubernetes',
    name: id,
    cluster: { name: 'demo' },
    access,
  });
}

it('mirrors a kubeconfig file into the blob and materializes it back (0600)', async () => {
  const store = fakeGsmStore();
  const appStore = new ConnectorAppStore({ store, keyDir });
  const path = join(keyDir, 'kubeconfig-k8s-demo.yaml');
  writeFileSync(path, 'apiVersion: v1\n');
  const inst = k8sConnector('k8s-demo', { mode: 'kubeconfig', kubeconfigPath: path });

  await appStore.sync([inst]);
  const blob = JSON.parse(store.values.get('connector-apps')!) as {
    connectors: Record<string, { kubeconfig?: string }>;
  };
  expect(blob.connectors['k8s-demo'].kubeconfig).toBe('apiVersion: v1\n');

  rmSync(path);
  const rehydrated = await appStore.loadAndMaterialize();
  expect(rehydrated?.map((c) => c.id)).toEqual(['k8s-demo']);
  expect(readFileSync(path, 'utf-8')).toBe('apiVersion: v1\n');
  expect(statSync(path).mode & 0o777).toBe(0o600);
});

it('mirrors token + CA files for token mode and leaves in-cluster instances secret-free', async () => {
  const store = fakeGsmStore();
  const appStore = new ConnectorAppStore({ store, keyDir });
  const tokenPath = join(keyDir, 'k8s-token-k8s-tok');
  const caPath = join(keyDir, 'k8s-ca-k8s-tok.pem');
  writeFileSync(tokenPath, 'tok\n');
  writeFileSync(caPath, 'PEM\n');
  await appStore.sync([
    k8sConnector('k8s-tok', { mode: 'token', server: 'https://h', tokenPath, caDataPath: caPath }),
    k8sConnector('k8s-in', { mode: 'in-cluster' }),
  ]);
  const blob = JSON.parse(store.values.get('connector-apps')!) as {
    connectors: Record<string, Record<string, unknown>>;
  };
  expect(blob.connectors['k8s-tok']).toMatchObject({ k8sToken: 'tok\n', k8sCa: 'PEM\n' });
  expect(Object.keys(blob.connectors['k8s-in'])).toEqual(['instance']);

  rmSync(tokenPath);
  rmSync(caPath);
  await appStore.loadAndMaterialize();
  expect(readFileSync(tokenPath, 'utf-8')).toBe('tok\n');
  expect(readFileSync(caPath, 'utf-8')).toBe('PEM\n');
});
```

Run: `cd packages/api-server && npx vitest run src/__tests__/services/connector-app-store.test.ts` → FAIL on the new cases (and possibly a type error on `c.app` now that the union exists).

Then in `packages/api-server/src/services/connector-app-store.ts`:

- `BlobRecord` gains:
  ```ts
  // Kubernetes instances: file contents of the paths in `instance.access`.
  kubeconfig?: string;
  k8sToken?: string;
  k8sCa?: string;
  ```
- Add a helper after the interfaces:
  ```ts
  function writeSecretFile(path: string, content: string): void {
    writeFileSync(path, content, { encoding: 'utf-8', mode: 0o600 });
    chmodSync(path, 0o600);
  }
  function readIfPresent(keyDir: string, configuredPath: string): string | undefined {
    const p = join(keyDir, basename(configuredPath));
    return existsSync(p) ? readFileSync(p, 'utf-8') : undefined;
  }
  ```
- In `sync()` wrap the existing PEM/webhook block in `if (c.type === 'github') { … }` and add:
  ```ts
  if (c.type === 'kubernetes') {
    const a = c.access;
    if (a.mode === 'kubeconfig') {
      const kubeconfig = readIfPresent(this.keyDir, a.kubeconfigPath);
      if (kubeconfig !== undefined) record.kubeconfig = kubeconfig;
    } else if (a.mode === 'token') {
      const token = readIfPresent(this.keyDir, a.tokenPath);
      if (token !== undefined) record.k8sToken = token;
      if (a.caDataPath) {
        const ca = readIfPresent(this.keyDir, a.caDataPath);
        if (ca !== undefined) record.k8sCa = ca;
      }
    }
  }
  ```
- In `loadAndMaterialize()` wrap the PEM block in `if (inst.type === 'github' && record.pem && inst.app?.id && inst.app?.privateKeyPath) { … }` (replace the two existing `writeFileSync`+`chmodSync` pairs with `writeSecretFile`) and add:
  ```ts
  if (inst.type === 'kubernetes') {
    const a = inst.access;
    if (a.mode === 'kubeconfig' && record.kubeconfig !== undefined) {
      writeSecretFile(join(this.keyDir, basename(a.kubeconfigPath)), record.kubeconfig);
    } else if (a.mode === 'token') {
      if (record.k8sToken !== undefined)
        writeSecretFile(join(this.keyDir, basename(a.tokenPath)), record.k8sToken);
      if (a.caDataPath && record.k8sCa !== undefined)
        writeSecretFile(join(this.keyDir, basename(a.caDataPath)), record.k8sCa);
    }
  }
  ```

Run the store tests again → PASS.

- [ ] **Step 6: Routes — failing tests**

Append to `packages/api-server/src/__tests__/routes/connectors.test.ts`. The Kubernetes probe test swaps the real client factory for a fake; add this **hoisted** mock next to the existing `vi.mock('@shipit-ai/connector-github', …)`:

```ts
const fakeK8sClients = {
  version: { getCode: vi.fn().mockResolvedValue({ gitVersion: 'v1.31.2' }) },
  core: {
    listNamespace: vi
      .fn()
      .mockResolvedValue({ items: [{ metadata: { name: 'shipit' } }], metadata: {} }),
    readNamespace: vi.fn(),
    listNode: vi.fn().mockResolvedValue({ items: [], metadata: {} }),
    listNamespacedPod: vi.fn().mockResolvedValue({ items: [], metadata: {} }),
  },
  apps: {
    listNamespacedDeployment: vi.fn().mockResolvedValue({ items: [], metadata: {} }),
    listNamespacedStatefulSet: vi.fn().mockResolvedValue({ items: [], metadata: {} }),
    listNamespacedDaemonSet: vi.fn().mockResolvedValue({ items: [], metadata: {} }),
    listNamespacedReplicaSet: vi.fn().mockResolvedValue({ items: [], metadata: {} }),
  },
  batch: { listNamespacedCronJob: vi.fn().mockResolvedValue({ items: [], metadata: {} }) },
};
vi.mock('@shipit-ai/connector-kubernetes', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@shipit-ai/connector-kubernetes')>();
  return { ...actual, defaultClientFactory: () => fakeK8sClients };
});
```

and the describe block:

```ts
describe('Kubernetes connector routes', () => {
  let server: FastifyInstance;
  let tmpDir: string;
  let keyDir: string;
  const previousKeyDir = process.env.SHIPIT_GITHUB_APP_KEY_DIR;

  const kubeconfig = `apiVersion: v1
kind: Config
clusters:
- name: demo
  cluster:
    server: https://10.0.0.1:6443
    certificate-authority-data: ${Buffer.from('ca').toString('base64')}
users:
- name: reader
  user:
    token: abc
contexts:
- name: demo
  context:
    cluster: demo
    user: reader
current-context: demo
`;

  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'shipit-k8s-routes-'));
    keyDir = join(tmpDir, 'keys');
    process.env.SHIPIT_GITHUB_APP_KEY_DIR = keyDir;
    const registry = new ConnectorRegistry({
      localConfigPath: join(tmpDir, 'shipit.config.local.yaml'),
      initial: [],
    });
    server = await createServer({ connectorRegistry: registry, config: makeTestConfig() });
    await server.ready();
  });

  afterAll(async () => {
    await server.close();
    rmSync(tmpDir, { recursive: true, force: true });
    if (previousKeyDir === undefined) delete process.env.SHIPIT_GITHUB_APP_KEY_DIR;
    else process.env.SHIPIT_GITHUB_APP_KEY_DIR = previousKeyDir;
  });

  it('POST /kubernetes/credentials stores a validated kubeconfig under the key dir with mode 0600', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/connectors/kubernetes/credentials',
      payload: { connectorId: 'k8s-demo', mode: 'kubeconfig', kubeconfig },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toEqual({
      mode: 'kubeconfig',
      kubeconfigPath: join(keyDir, 'kubeconfig-k8s-demo.yaml'),
      context: 'demo',
      contexts: ['demo'],
    });
    expect(readFileSync(body.kubeconfigPath, 'utf-8')).toBe(kubeconfig);
    expect(statSync(body.kubeconfigPath).mode & 0o777).toBe(0o600);
  });

  it('POST /kubernetes/credentials rejects exec kubeconfigs, bad ids and unknown modes', async () => {
    const exec = kubeconfig.replace(
      'token: abc',
      'exec:\n      apiVersion: client.authentication.k8s.io/v1beta1\n      command: gke-gcloud-auth-plugin',
    );
    const r1 = await server.inject({
      method: 'POST',
      url: '/api/connectors/kubernetes/credentials',
      payload: { connectorId: 'k8s-demo', mode: 'kubeconfig', kubeconfig: exec },
    });
    expect(r1.statusCode).toBe(400);
    expect(r1.json().error.code).toBe('UNSUPPORTED_AUTH_PLUGIN');
    const r2 = await server.inject({
      method: 'POST',
      url: '/api/connectors/kubernetes/credentials',
      payload: { connectorId: '../etc', mode: 'kubeconfig', kubeconfig },
    });
    expect(r2.statusCode).toBe(400);
    const r3 = await server.inject({
      method: 'POST',
      url: '/api/connectors/kubernetes/credentials',
      payload: { connectorId: 'x', mode: 'password' },
    });
    expect(r3.statusCode).toBe(400);
  });

  it('POST /kubernetes/credentials stores a token and PEM CA for mode token', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/connectors/kubernetes/credentials',
      payload: {
        connectorId: 'k8s-tok',
        mode: 'token',
        token: ' tok ',
        caData: '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----',
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      mode: 'token',
      tokenPath: join(keyDir, 'k8s-token-k8s-tok'),
      caDataPath: join(keyDir, 'k8s-ca-k8s-tok.pem'),
    });
    expect(readFileSync(join(keyDir, 'k8s-token-k8s-tok'), 'utf-8')).toBe('tok\n');
  });

  it('POST / creates a kubernetes connector and GET /:id returns it with defaults', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/connectors',
      payload: {
        id: 'k8s-demo',
        type: 'kubernetes',
        name: 'Demo',
        cluster: { name: 'shipit-demo' },
        access: {
          mode: 'kubeconfig',
          kubeconfigPath: join(keyDir, 'kubeconfig-k8s-demo.yaml'),
          context: 'demo',
        },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.headers.etag).toBeDefined();
    const get = await server.inject({ method: 'GET', url: '/api/connectors/k8s-demo' });
    expect(get.json()).toMatchObject({
      type: 'kubernetes',
      schedule: '*/5 * * * *',
      scope: { kinds: ['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob'] },
      lastRuns: [],
    });
  });

  it('POST / and PATCH /:id refuse credential paths outside the key dir', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/connectors',
      payload: {
        id: 'k8s-bad',
        type: 'kubernetes',
        name: 'Bad',
        cluster: { name: 'c' },
        access: { mode: 'kubeconfig', kubeconfigPath: '/etc/passwd' },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CREDENTIAL_PATH_NOT_ALLOWED');
    const patch = await server.inject({
      method: 'PATCH',
      url: '/api/connectors/k8s-demo',
      payload: { access: { mode: 'token', server: 'https://h', tokenPath: '/etc/shadow' } },
    });
    expect(patch.statusCode).toBe(400);
    expect(patch.json().error.code).toBe('CREDENTIAL_PATH_NOT_ALLOWED');
  });

  it('POST / still requires installationId/org for github and rejects unknown types', async () => {
    const gh = await server.inject({
      method: 'POST',
      url: '/api/connectors',
      payload: { id: 'gh-x', type: 'github', name: 'X' },
    });
    expect(gh.statusCode).toBe(400);
    const unknown = await server.inject({
      method: 'POST',
      url: '/api/connectors',
      payload: { id: 'x', type: 'datadog', name: 'X' },
    });
    expect(unknown.statusCode).toBe(400);
  });

  it('POST /probe with type kubernetes returns version, namespaces and per-kind access', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/connectors/probe',
      payload: { type: 'kubernetes', access: { mode: 'token', server: 'https://h', token: 't' } },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      cluster: { version: 'v1.31.2' },
      namespaces: ['shipit'],
      kinds: { Deployment: 'ok', StatefulSet: 'ok', DaemonSet: 'ok', CronJob: 'ok' },
    });
  });

  it('POST /probe with type kubernetes rejects out-of-dir paths and surfaces connector codes as 400', async () => {
    const bad = await server.inject({
      method: 'POST',
      url: '/api/connectors/probe',
      payload: {
        type: 'kubernetes',
        access: { mode: 'kubeconfig', kubeconfigPath: '/etc/passwd' },
      },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().code).toBe('CREDENTIAL_PATH_NOT_ALLOWED');
    const noCluster = await server.inject({
      method: 'POST',
      url: '/api/connectors/probe',
      payload: { type: 'kubernetes', access: { mode: 'in-cluster' } },
    });
    expect(noCluster.statusCode).toBe(400);
    expect(noCluster.json().code).toBe('IN_CLUSTER_UNAVAILABLE');
  });
});
```

Run: `cd packages/api-server && npx vitest run src/__tests__/routes/connectors.test.ts -t Kubernetes` → FAIL (404s / 400s).

- [ ] **Step 7: Routes — implementation**

In `packages/api-server/src/routes/connectors.ts`:

Imports:

```ts
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { validateKubeconfigText } from '@shipit-ai/connector-kubernetes';
import { getConnectorType } from '../services/connector-types/index.js';
import type { BuildContext } from '../services/connector-types/types.js';
```

After `PRIVATE_KEY_PATH_NOT_ALLOWED_MESSAGE`:

```ts
const CREDENTIAL_PATH_NOT_ALLOWED_MESSAGE =
  'Credential paths must point at a file directly inside the configured keys ' +
  'directory (SHIPIT_GITHUB_APP_KEY_DIR, default ~/.shipit/keys). Use POST ' +
  '/api/connectors/kubernetes/credentials to store them there.';

// Same predicate as the PEM allowlist, applied to every *Path in a Kubernetes
// `access` block (create, patch and probe bodies).
function kubernetesAccessPathError(
  access: { kubeconfigPath?: string; tokenPath?: string; caDataPath?: string } | undefined,
): string | null {
  for (const key of ['kubeconfigPath', 'tokenPath', 'caDataPath'] as const) {
    const candidate = access?.[key]?.trim();
    if (candidate && !isAllowedKeyPath(candidate))
      return `${key}: ${CREDENTIAL_PATH_NOT_ALLOWED_MESSAGE}`;
  }
  return null;
}

function writeSecretFile(path: string, content: string): void {
  writeFileSync(path, content, { encoding: 'utf-8', mode: 0o600 });
  chmodSync(path, 0o600);
}

const CONNECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
```

Body types — replace `CreateConnectorBody` with a union and extend `UpdateConnectorBody`:

```ts
interface CreateGitHubConnectorBody {
  id: string;
  type: 'github';
  name: string;
  enabled?: boolean;
  installationId: string;
  org: string;
  schedule?: string;
  scope?: unknown;
  entities?: unknown;
  app?: { id?: string; privateKeyPath?: string };
}
interface CreateKubernetesConnectorBody {
  id: string;
  type: 'kubernetes';
  name: string;
  enabled?: boolean;
  schedule?: string;
  cluster: { name: string };
  access: {
    mode: string;
    kubeconfigPath?: string;
    context?: string;
    server?: string;
    tokenPath?: string;
    caDataPath?: string;
  };
  scope?: unknown;
  mapping?: unknown;
}
type CreateConnectorBody = CreateGitHubConnectorBody | CreateKubernetesConnectorBody;

interface UpdateConnectorBody {
  enabled?: boolean;
  name?: string;
  schedule?: string;
  scope?: unknown;
  entities?: unknown;
  app?: { id?: string; privateKeyPath?: string } | null;
  cluster?: unknown;
  access?: { kubeconfigPath?: string; tokenPath?: string; caDataPath?: string } | null;
  mapping?: unknown;
}

interface KubernetesCredentialsBody {
  connectorId: string;
  mode: 'kubeconfig' | 'token';
  kubeconfig?: string;
  context?: string;
  token?: string;
  caData?: string;
}
```

Inside the plugin, after `const runStore = registry.getRunStore();`:

```ts
// Build context for factory probes run from routes (no memoization needed).
const routeBuildContext = (): BuildContext => {
  const cfg = (server as unknown as { config?: Config }).config;
  return {
    globalApp: cfg?.connectors.github.app ?? { id: '', privateKeyPath: '' },
    readPrivateKey: (p) => readFileSync(join(getAllowedKeyDir(), basename(p)), 'utf-8'),
    keyDir: getAllowedKeyDir(),
    listConnectors: () => registry.list(),
  };
};
```

`POST /` — replace the handler body's validation + create with:

```ts
const body = request.body;
if (!body || !body.id || !body.name || (body.type !== 'github' && body.type !== 'kubernetes')) {
  return reply.status(400).send({
    error: {
      code: 'VALIDATION_ERROR',
      message: 'id, type ("github" | "kubernetes"), and name are required',
    },
  });
}
if (body.type === 'github') {
  if (!body.installationId || !body.org) {
    return reply.status(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'installationId and org are required for github connectors',
      },
    });
  }
  // (existing createOverridePath / PRIVATE_KEY_PATH_NOT_ALLOWED guard stays here, unchanged)
} else {
  if (!body.cluster?.name || !body.access?.mode) {
    return reply.status(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'cluster.name and access.mode are required for kubernetes connectors',
      },
    });
  }
  const pathErr = kubernetesAccessPathError(body.access);
  if (pathErr) {
    return reply
      .status(400)
      .send({ error: { code: 'CREDENTIAL_PATH_NOT_ALLOWED', message: pathErr } });
  }
}
try {
  const created =
    body.type === 'github'
      ? await registry.create({
          type: 'github',
          id: body.id,
          name: body.name,
          enabled: body.enabled,
          installationId: body.installationId,
          org: body.org,
          schedule: body.schedule,
          scope: body.scope as never,
          entities: body.entities as never,
          app: body.app,
        })
      : await registry.create({
          type: 'kubernetes',
          id: body.id,
          name: body.name,
          enabled: body.enabled,
          schedule: body.schedule,
          cluster: body.cluster,
          access: body.access as never,
          scope: body.scope as never,
          mapping: body.mapping as never,
        });
  reply.header('ETag', `"${registry.getHash(created.id)}"`);
  return reply.status(201).send(created);
} catch (err) {
  // (existing DUPLICATE / VALIDATION_ERROR mapping, unchanged)
}
```

`PATCH /:id` — after the existing `patchOverridePath` guard add:

```ts
const patchAccessErr = request.body?.access ? kubernetesAccessPathError(request.body.access) : null;
if (patchAccessErr) {
  return reply
    .status(400)
    .send({ error: { code: 'CREDENTIAL_PATH_NOT_ALLOWED', message: patchAccessErr } });
}
```

and pass `cluster: request.body?.cluster, access: request.body?.access ?? undefined, mapping: request.body?.mapping` into `registry.update(...)`.

New route (place it before the `POST /:id/sync` block; static segments win over `/:id` in Fastify regardless of order, but keeping it near the other Kubernetes code reads better):

```ts
// POST /api/connectors/kubernetes/credentials — store a pasted kubeconfig or
// ServiceAccount token (+ PEM CA) as files inside the key dir and return the
// paths a subsequent POST /api/connectors can reference. Validated BEFORE
// writing; never echoes the secret back. Mirrors the per-org PEM flow.
server.post<{ Body: KubernetesCredentialsBody }>(
  '/kubernetes/credentials',
  { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
  async (request, reply) => {
    const body = request.body ?? ({} as KubernetesCredentialsBody);
    if (!body.connectorId || !CONNECTOR_ID.test(body.connectorId)) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'connectorId is required ([A-Za-z0-9_-], max 64 chars)',
        },
      });
    }
    const dir = getAllowedKeyDir();
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (body.mode === 'kubeconfig') {
      if (!body.kubeconfig) {
        return reply.status(400).send({
          error: {
            code: 'VALIDATION_ERROR',
            message: 'kubeconfig is required for mode kubeconfig',
          },
        });
      }
      const v = validateKubeconfigText(body.kubeconfig, body.context?.trim() || undefined);
      if (!v.ok) return reply.status(400).send({ error: { code: v.code, message: v.message } });
      const kubeconfigPath = join(dir, `kubeconfig-${body.connectorId}.yaml`);
      writeSecretFile(kubeconfigPath, body.kubeconfig);
      return reply.status(201).send({
        mode: 'kubeconfig',
        kubeconfigPath,
        context: v.currentContext,
        contexts: v.contexts,
      });
    }
    if (body.mode === 'token') {
      const token = body.token?.trim();
      if (!token) {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: 'token is required for mode token' },
        });
      }
      const tokenPath = join(dir, `k8s-token-${body.connectorId}`);
      writeSecretFile(tokenPath, token + '\n');
      let caDataPath: string | undefined;
      if (body.caData) {
        if (!/-----BEGIN CERTIFICATE-----/.test(body.caData)) {
          return reply.status(400).send({
            error: { code: 'VALIDATION_ERROR', message: 'caData must be a PEM certificate' },
          });
        }
        caDataPath = join(dir, `k8s-ca-${body.connectorId}.pem`);
        writeSecretFile(caDataPath, body.caData.trim() + '\n');
      }
      return reply
        .status(201)
        .send({ mode: 'token', tokenPath, ...(caDataPath ? { caDataPath } : {}) });
    }
    return reply.status(400).send({
      error: { code: 'VALIDATION_ERROR', message: 'mode must be "kubeconfig" or "token"' },
    });
  },
);
```

`POST /probe` — as the first statements of the handler (before `const { installationId, suggestedOrg } = …`):

```ts
const probeBody = request.body as
  (ProbeBody & { type?: string; access?: Record<string, string> }) | undefined;
if (probeBody?.type === 'kubernetes') {
  const k8s = getConnectorType('kubernetes');
  if (!k8s?.probe) {
    return reply.status(503).send({
      ok: false,
      code: 'SERVICE_UNAVAILABLE',
      message: 'Kubernetes connector type is not registered.',
    });
  }
  const pathErr = kubernetesAccessPathError(probeBody.access);
  if (pathErr)
    return reply
      .status(400)
      .send({ ok: false, code: 'CREDENTIAL_PATH_NOT_ALLOWED', message: pathErr });
  const result = await k8s.probe(probeBody, routeBuildContext());
  return reply.status(result.ok ? 200 : 400).send(result);
}
```

- [ ] **Step 8: Run the api-server suite, typecheck and build**

Run: `cd packages/api-server && npx tsc --noEmit && npx vitest run && cd ../.. && pnpm turbo build --filter=@shipit-ai/api-server`
Expected: PASS / clean / built. `pnpm install --frozen-lockfile` must also succeed (lockfile committed with the workspace link).

- [ ] **Step 9: Commit**

```bash
git add pnpm-lock.yaml packages/api-server
git commit -m "api-server: kubernetes connector type, credentials route, probe and GSM blob durability"
```

---

### Task 12: Cross-source acceptance test (GitHub + Kubernetes → writer → Neo4j → sweep)

Implements spec §Testing (acceptance) and proves success criteria 1, 3 and 4 end to end against a real Neo4j.

**Files:**

- Modify: `packages/core-writer/package.json` — add to `devDependencies`: `"@shipit-ai/connector-github": "workspace:*"`, `"@shipit-ai/connector-kubernetes": "workspace:*"`; then `pnpm install`.
- Modify: `packages/core-writer/tsconfig.json` — `references` gains `{ "path": "../connectors/github" }` and `{ "path": "../connectors/kubernetes" }`.
- Create: `packages/core-writer/src/__tests__/acceptance/reference-cluster.ts`
- Create: `packages/core-writer/src/__tests__/acceptance/cross-source.integration.test.ts`

**Interfaces:**

- Consumes: `normalizeRepository`, `normalizeTeam`, `GitHubRepo`, `GitHubTeam` (connector-github); `normalizeCluster`, `normalizeNamespace`, `normalizeWorkload`, `NormalizerContext`, `RawWorkload` (connector-kubernetes); `buildIdempotencyKey` (event-bus); `CoreWriter`, Neo4j adapters (core-writer); `KUBERNETES_DEFAULT_MAPPING` (shared).
- Produces: the reference fixture other suites can reuse.

- [ ] **Step 1: Write the fixture**

Create `packages/core-writer/src/__tests__/acceptance/reference-cluster.ts`:

```ts
// Reference cross-source fixture: one GitHub org (repo + team) and one cluster
// (namespace + three workloads) shaped like the real demo chart. Used by the
// acceptance test below; keep it small and literal.
import type { GitHubRepo, GitHubTeam } from '@shipit-ai/connector-github';
import type {
  NamespaceRef,
  NormalizerContext,
  RawCluster,
  RawNamespace,
  RawWorkload,
} from '@shipit-ai/connector-kubernetes';
import { EMPTY_POD_SUMMARY } from '@shipit-ai/connector-kubernetes';
import { KUBERNETES_DEFAULT_MAPPING } from '@shipit-ai/shared';

export const GITHUB_ORG = 'Ship-It-Ops';
export const GITHUB_CONNECTOR = 'gh-ship-it-ops';
export const K8S_CONNECTOR = 'k8s-demo';
export const CLUSTER = 'shipit-demo';

export const REPO_ID = 'shipit://repository/default/Ship-It-Ops/ShipIt-AI';
export const TEAM_ID = 'shipit://team/default/Ship-It-Ops/platform-team';
export const SERVICE_ID = 'shipit://logical-service/default/shipit-ai';
export const API_SERVER_ID = 'shipit://deployment/default/shipit-demo/shipit/deployment/api-server';
export const WEB_UI_ID = 'shipit://deployment/default/shipit-demo/shipit/deployment/web-ui';
export const REDIS_ID = 'shipit://deployment/default/shipit-demo/shipit/statefulset/redis';
export const WEB_UI_ARTIFACT_ID =
  'shipit://build-artifact/default/us-central1-docker.pkg.dev/ship-it-ai-portal/shipit-ai/web-ui@sha-97189de';
export const ALL_DEPLOYMENTS = [API_SERVER_ID, REDIS_ID, WEB_UI_ID].sort();

export const referenceRepo: GitHubRepo = {
  name: 'ShipIt-AI',
  full_name: 'Ship-It-Ops/ShipIt-AI',
  html_url: 'https://github.com/Ship-It-Ops/ShipIt-AI',
  default_branch: 'main',
  visibility: 'public',
  language: 'TypeScript',
  topics: ['knowledge-graph'],
  archived: false,
  description: 'AI-ready knowledge graph builder',
  updated_at: '2026-09-16T00:00:00Z',
  pushed_at: '2026-09-16T00:00:00Z',
};

export const referenceTeam: GitHubTeam = {
  slug: 'platform-team',
  name: 'Platform Team',
  description: null,
  privacy: 'closed',
  html_url: 'https://github.com/orgs/Ship-It-Ops/teams/platform-team',
  members: [
    {
      login: 'mohamed-e',
      avatar_url: '',
      html_url: 'https://github.com/mohamed-e',
      role: 'maintainer',
    },
  ],
};

export const referenceCluster: RawCluster = {
  __shipit: 'cluster',
  name: CLUSTER,
  version: 'v1.31.2-gke.1',
  provider: 'gcp',
  region: 'us-central1',
};

const namespaceRef: NamespaceRef = {
  name: 'shipit',
  labels: { environment: 'production', team: 'Platform Team' },
  annotations: {},
};

export const referenceNamespace: RawNamespace = {
  __shipit: 'namespace',
  object: { metadata: { name: 'shipit', labels: namespaceRef.labels } },
};

const chartLabels = (component: string) => ({
  'app.kubernetes.io/name': 'shipit-ai',
  'app.kubernetes.io/instance': 'shipit',
  'app.kubernetes.io/component': component,
});

function deployment(
  name: string,
  image: string,
  annotations: Record<string, string> = {},
): RawWorkload {
  return {
    __shipit: 'workload',
    kind: 'Deployment',
    namespace: namespaceRef,
    pods: EMPTY_POD_SUMMARY,
    object: {
      metadata: { name, namespace: 'shipit', labels: chartLabels(name), annotations },
      spec: {
        replicas: 1,
        selector: { matchLabels: chartLabels(name) },
        template: { spec: { containers: [{ name, image }] } },
      },
      status: {
        replicas: 1,
        readyReplicas: 1,
        conditions: [{ type: 'Available', status: 'True' }],
      },
    },
  };
}

export const referenceWorkloads: RawWorkload[] = [
  deployment(
    'api-server',
    'us-central1-docker.pkg.dev/ship-it-ai-portal/shipit-ai/api-server:sha-97189de',
    { 'shipit.ai/github-repo': 'Ship-It-Ops/ShipIt-AI' },
  ),
  deployment('web-ui', 'us-central1-docker.pkg.dev/ship-it-ai-portal/shipit-ai/web-ui:sha-97189de'),
  {
    __shipit: 'workload',
    kind: 'StatefulSet',
    namespace: namespaceRef,
    pods: EMPTY_POD_SUMMARY,
    object: {
      metadata: { name: 'redis', namespace: 'shipit', labels: chartLabels('redis') },
      spec: {
        replicas: 1,
        serviceName: 'redis',
        selector: { matchLabels: chartLabels('redis') },
        template: { spec: { containers: [{ name: 'redis', image: 'redis:7-alpine' }] } },
      },
      status: { replicas: 1, readyReplicas: 1 },
    },
  },
];

export function contextAt(now: string): NormalizerContext {
  return {
    cluster: CLUSTER,
    mapping: KUBERNETES_DEFAULT_MAPPING,
    githubOrg: GITHUB_ORG,
    knownRepositories: ['ShipIt-AI'],
    knownTeams: ['platform-team'],
    now,
  };
}
```

- [ ] **Step 2: Write the acceptance test**

Create `packages/core-writer/src/__tests__/acceptance/cross-source.integration.test.ts`:

```ts
/**
 * Cross-source ACCEPTANCE test (spec §Testing; success criteria 1, 3, 4).
 * GitHub fixtures + the reference cluster flow through the real CoreWriter into
 * Neo4j; the graph is then queried the way blast_radius does; finally a
 * sync.completed sweep hides a workload that vanished. Gated on NEO4J_TEST_URI;
 * wipes the graph; serial in CI (shared-DB scar).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { CanonicalEntity, EventEnvelope } from '@shipit-ai/shared';
import { buildIdempotencyKey } from '@shipit-ai/event-bus';
import { normalizeRepository, normalizeTeam } from '@shipit-ai/connector-github';
import {
  normalizeCluster,
  normalizeNamespace,
  normalizeWorkload,
} from '@shipit-ai/connector-kubernetes';
import { CoreWriter } from '../../writer.js';
import { DEFAULT_CONFIG } from '../../config.js';
import { Neo4jClient } from '../../neo4j/client.js';
import { Neo4jNodeWriter } from '../../neo4j/node-writer.js';
import { Neo4jLinkingKeyIndex } from '../../neo4j/linking-key-index.js';
import { Neo4jIdempotencyChecker } from '../../neo4j/idempotency-checker.js';
import {
  ALL_DEPLOYMENTS,
  GITHUB_CONNECTOR,
  GITHUB_ORG,
  K8S_CONNECTOR,
  REPO_ID,
  SERVICE_ID,
  TEAM_ID,
  WEB_UI_ARTIFACT_ID,
  WEB_UI_ID,
  contextAt,
  referenceCluster,
  referenceNamespace,
  referenceRepo,
  referenceTeam,
  referenceWorkloads,
} from './reference-cluster.js';

const URI = process.env.NEO4J_TEST_URI;
const USER = process.env.NEO4J_TEST_USER ?? 'neo4j';
const PASSWORD = process.env.NEO4J_TEST_PASSWORD ?? 'testpassword';
const DATABASE = process.env.NEO4J_TEST_DATABASE;

// Same shape the BullMQ producer emits: one envelope per node carrying the whole entity.
function envelopes(entity: CanonicalEntity, connectorId: string): EventEnvelope[] {
  const now = new Date().toISOString();
  return entity.nodes.map((node) => ({
    id: randomUUID(),
    timestamp: now,
    connector_id: connectorId,
    idempotency_key: buildIdempotencyKey(connectorId, node),
    payload: entity,
  }));
}

function controlEnvelope(connectorId: string, startedAt: string): EventEnvelope {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    connector_id: connectorId,
    idempotency_key: `${connectorId}~sync-completed~${Date.parse(startedAt)}`,
    payload: { nodes: [], edges: [] },
    kind: 'sync.completed',
    control: { kind: 'sync.completed', startedAt, mode: 'full' },
  };
}

function merge(
  ...parts: Array<{ nodes: CanonicalEntity['nodes']; edges: CanonicalEntity['edges'] }>
): CanonicalEntity {
  const nodes = new Map<string, CanonicalEntity['nodes'][number]>();
  const edges = new Map<string, CanonicalEntity['edges'][number]>();
  for (const p of parts) {
    for (const n of p.nodes) if (!nodes.has(n.id)) nodes.set(n.id, n);
    for (const e of p.edges) {
      const key = `${e.type}|${e.from}|${e.to}`;
      const prev = edges.get(key);
      if (!prev || e._confidence > prev._confidence) edges.set(key, e);
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

// Mirrors the MCP generator's BOTH direction over dependency edges.
const BLAST = `MATCH (r:Repository {id: $id})-[:IMPLEMENTED_BY|DEPLOYED_AS*1..2]-(n:Deployment)
  WHERE n._absent_since IS NULL RETURN DISTINCT n.id AS id`;
const BLAST_INCLUDING_ABSENT = `MATCH (r:Repository {id: $id})-[:IMPLEMENTED_BY|DEPLOYED_AS*1..2]-(n:Deployment)
  RETURN DISTINCT n.id AS id`;

describe.skipIf(!URI)('acceptance — GitHub + Kubernetes cross-source graph', () => {
  let client: Neo4jClient;
  let writer: CoreWriter;

  const wipe = () =>
    client.executeWrite(async (tx) => tx.run('MATCH (n) DETACH DELETE n'), DATABASE);
  const rows = (cypher: string, params: Record<string, unknown> = {}) =>
    client.executeRead(async (tx) => (await tx.run(cypher, params)).records, DATABASE);
  const ids = async (cypher: string, params: Record<string, unknown> = {}) =>
    (await rows(cypher, params)).map((r) => String(r.get('id'))).sort();

  beforeAll(async () => {
    client = new Neo4jClient();
    await client.connect({ uri: URI!, username: USER, password: PASSWORD, database: DATABASE });
    writer = new CoreWriter(
      new Neo4jNodeWriter(client, DATABASE),
      new Neo4jLinkingKeyIndex(client, DATABASE),
      new Neo4jIdempotencyChecker(client, 30, DATABASE),
      DEFAULT_CONFIG,
    );
    await wipe();
  });

  afterAll(async () => {
    await wipe();
    await client?.close();
  });

  it('run 1: both sources land and the workloads link to the repository and team', async () => {
    const T1 = '2026-09-16T12:00:00.000Z';
    const github = merge(
      normalizeRepository(referenceRepo, GITHUB_ORG),
      normalizeTeam(referenceTeam, GITHUB_ORG),
    );
    const ctx = contextAt(T1);
    const k8s = merge(
      normalizeCluster(referenceCluster, ctx),
      normalizeNamespace(referenceNamespace, ctx),
      ...referenceWorkloads.map((w) => normalizeWorkload(w, ctx)),
    );

    const r1 = await writer.processBatch(envelopes(github, GITHUB_CONNECTOR));
    const r2 = await writer.processBatch(envelopes(k8s, K8S_CONNECTOR));
    expect(r1.errors).toEqual([]);
    expect(r2.errors).toEqual([]);

    expect(await ids('MATCH (d:Deployment) RETURN d.id AS id')).toEqual(ALL_DEPLOYMENTS);
    expect(await ids('MATCH (c:Cluster) RETURN c.id AS id')).toEqual([
      'shipit://cluster/default/shipit-demo',
    ]);

    // Deployment → BuildArtifact → Repository (annotation tier on api-server)
    expect(
      await ids(
        `MATCH (d:Deployment {name: 'api-server'})-[:RUNS_IMAGE]->(:BuildArtifact)-[:BUILT_FROM]->(r:Repository) RETURN r.id AS id`,
      ),
    ).toEqual([REPO_ID]);

    // One LogicalService, linked to the repo by the best available signal
    const impl = await rows(
      `MATCH (s:LogicalService {id: $s})-[e:IMPLEMENTED_BY]->(r:Repository) RETURN r.id AS id, e.link_method AS method, e._confidence AS confidence`,
      { s: SERVICE_ID },
    );
    expect(impl).toHaveLength(1);
    expect(String(impl[0].get('id'))).toBe(REPO_ID);
    expect(impl[0].get('method')).toBe('annotation');
    expect(Number(impl[0].get('confidence'))).toBe(1);

    // Team OWNS LogicalService via the namespace team label
    expect(
      await ids(`MATCH (t:Team)-[:OWNS]->(s:LogicalService {id: $s}) RETURN t.id AS id`, {
        s: SERVICE_ID,
      }),
    ).toEqual([TEAM_ID]);

    // Success criterion 3: blast radius from the repository reaches every workload
    expect(await ids(BLAST, { id: REPO_ID })).toEqual(ALL_DEPLOYMENTS);
  });

  it('run 2: a vanished workload is marked absent and hidden from the traversal', async () => {
    const T2 = '2026-09-16T12:10:00.000Z';
    const ctx = contextAt(T2);
    const survivors = referenceWorkloads.filter((w) => w.object.metadata?.name !== 'web-ui');
    const k8s = merge(
      normalizeCluster(referenceCluster, ctx),
      normalizeNamespace(referenceNamespace, ctx),
      ...survivors.map((w) => normalizeWorkload(w, ctx)),
    );
    const rerun = await writer.processBatch(envelopes(k8s, K8S_CONNECTOR));
    expect(rerun.errors).toEqual([]);
    // Unchanged content dedups; the touch path still refreshes `_last_synced`.
    expect(rerun.duplicatesSkipped).toBeGreaterThan(0);

    const sweep = await writer.processBatch([
      controlEnvelope(K8S_CONNECTOR, '2026-09-16T12:05:00.000Z'),
    ]);
    // The workload AND its (now unreferenced) image artifact were both unseen.
    expect(sweep.absentMarked).toBe(2);
    expect(await ids('MATCH (n) WHERE n._absent_since IS NOT NULL RETURN n.id AS id')).toEqual(
      [WEB_UI_ARTIFACT_ID, WEB_UI_ID].sort(),
    );

    // Success criterion 4: hidden by default, visible on request
    expect(await ids(BLAST, { id: REPO_ID })).toEqual(
      ALL_DEPLOYMENTS.filter((id) => id !== WEB_UI_ID),
    );
    expect(await ids(BLAST_INCLUDING_ABSENT, { id: REPO_ID })).toEqual(ALL_DEPLOYMENTS);

    // GitHub's nodes belong to another instance and are never swept by k8s
    expect(
      await ids(`MATCH (r:Repository) WHERE r._absent_since IS NULL RETURN r.id AS id`),
    ).toEqual([REPO_ID]);
  });
});
```

- [ ] **Step 3: Run it against a scratch Neo4j**

Run: `docker compose -f docker/docker-compose.yml up -d neo4j` then
`cd packages/core-writer && NEO4J_TEST_URI=bolt://localhost:7687 NEO4J_TEST_PASSWORD=<local password> npx vitest run src/__tests__/acceptance/cross-source.integration.test.ts`
Expected: PASS (2 tests). `npx tsc --noEmit` clean. `pnpm turbo build --force` still resolves (connectors build before core-writer through the devDependency edge; no cycle because connectors depend only on shared + connector-sdk).

- [ ] **Step 4: Commit**

```bash
git add pnpm-lock.yaml packages/core-writer
git commit -m "core-writer: cross-source acceptance test (GitHub + Kubernetes reference fixtures, blast radius, absence sweep)"
```

---

### Task 13: Docs, committed config example, infra brief, spec/agent-context reconciliation

Implements spec §Infra brief, §Rollout (docs), and records the two design refinements made while planning (known-name lists; best-edge dedupe).

**Files:**

- Modify: `docs/connectors.md` (replace the `## Kubernetes Connector (Planned)` section, lines ~184–192)
- Modify: `README.md` (tree line ~98, connector table ~172, roadmap ~211–216)
- Modify: `shipit.config.yaml` (`connectors.instances` ~line 133)
- Create: `docs/agent/briefs/infra-k8s-reader-clusterrole.md`
- Modify: `docs/superpowers/specs/2026-09-16-kubernetes-connector-design.md` (§Repository linking tiers, §Data model edges)
- Modify: `docs/agent/decisions/kubernetes-connector-v1-design.md`, `docs/agent/status/kubernetes-connector-v1.md`

- [ ] **Step 1: `docs/connectors.md`**

Replace the four-line "(Planned)" section with:

````markdown
## Kubernetes Connector

Polls a cluster read-only (every 5 minutes by default, full list each run) and emits
`Cluster`, `Namespace`, `Environment`, `Deployment` (one per Deployment / StatefulSet /
DaemonSet / CronJob), `BuildArtifact` and `LogicalService` nodes with `PART_OF`, `RUNS_IN`,
`RUNS_IN_ENV`, `RUNS_IMAGE`, `DEPLOYED_AS`, `IMPLEMENTED_BY`, `BUILT_FROM` and `OWNS` edges.
One connector instance per cluster. Design: `docs/superpowers/specs/2026-09-16-kubernetes-connector-design.md`.

### Access modes

| mode         | what you provide                                  | notes                                                                             |
| ------------ | ------------------------------------------------- | --------------------------------------------------------------------------------- |
| `in-cluster` | nothing                                           | uses the api-server pod's ServiceAccount; needs the read-only ClusterRole below   |
| `kubeconfig` | a kubeconfig (one context, or `context` named)    | `exec` / `auth-provider` users are rejected — mint a ServiceAccount token instead |
| `token`      | `server`, a ServiceAccount token, optional CA PEM | TLS verification is always on                                                     |

Credentials never live in YAML. Store them first, then reference the returned paths:

```bash
curl -X POST localhost:3001/api/connectors/kubernetes/credentials \
  -H 'Content-Type: application/json' \
  -d '{ "connectorId": "k8s-demo", "mode": "token", "server": "https://10.0.0.1:6443", "token": "<sa-token>", "caData": "-----BEGIN CERTIFICATE-----..." }'
# → { "mode": "token", "tokenPath": "~/.shipit/keys/k8s-token-k8s-demo", "caDataPath": "~/.shipit/keys/k8s-ca-k8s-demo.pem" }

curl -X POST localhost:3001/api/connectors -H 'Content-Type: application/json' -d '{
  "id": "k8s-demo", "type": "kubernetes", "name": "Demo cluster",
  "cluster": { "name": "shipit-demo" },
  "access": { "mode": "token", "server": "https://10.0.0.1:6443", "tokenPath": "~/.shipit/keys/k8s-token-k8s-demo", "caDataPath": "~/.shipit/keys/k8s-ca-k8s-demo.pem" }
}'
```

`POST /api/connectors/probe` with `{ "type": "kubernetes", "access": { ... } }` checks access before you
save: it returns the server version, the namespaces in scope and, per workload kind, `ok` or `forbidden`.

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
    resources: [jobs, cronjobs]
    verbs: [get, list, watch]
```

Bind it to the ShipIt ServiceAccount (in-cluster) or to the ServiceAccount whose token you paste.
A kind the account may not list is reported as `FORBIDDEN:<kind>` on the run and the run is
marked partial; everything else still syncs.

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
    default: null # then this; otherwise no Environment
  ownership: { teamLabel: team } # slugified → GitHub team
  repoLink:
    annotation: shipit.ai/github-repo # tier 1: "<org>/<repo>", confidence 1.0
    githubOrg: null # tier 2/3 org; null = the sole GitHub connector's org
    nameMatch: true # tier 2: image name (0.7); tier 3: app.kubernetes.io/name (0.6)
```

Name tiers only link to repositories and teams GitHub has already synced. Put
`shipit.ai/github-repo: <org>/<repo>` on a workload (or its namespace) to pin the link.

### Absence

After every successful run the connector's unseen nodes get `_absent_since` and disappear from
the catalog, graph and MCP tools. Pass `includeAbsent=true` (API) or `include_absent: true`
(MCP) to see them. Nothing is deleted.

### Not in v1

Watch API streaming, Argo CD / Flux link signals, OCI image-label provenance, Services/Ingress
as nodes, Secrets/ConfigMaps/Events.
````

- [ ] **Step 2: README**

- Tree line: `│   │   └── kubernetes/      # Kubernetes connector (workloads, namespaces, images; polling)`
- Connector table row: `| Kubernetes | Available          | Cluster, Namespace, Environment, Deployment (Deployment/StatefulSet/DaemonSet/CronJob), BuildArtifact, LogicalService |`
- Roadmap: under `### Phase 1b (Weeks 5-8)` replace the Kubernetes bullet with `- ~~Kubernetes connector~~ — shipped (polling, absence sweep); Watch API streaming follows` and leave the other bullets.

- [ ] **Step 3: `shipit.config.yaml`**

Under `connectors:` replace `instances: []` with:

```yaml
# Configured connector instances. Runtime-created instances land in
# shipit.config.local.yaml (and, on GSM deployments, the connector-apps blob).
# A Kubernetes instance looks like this (credentials are FILES in the key
# dir, written by POST /api/connectors/kubernetes/credentials — never inline):
#
#   - id: k8s-demo
#     type: kubernetes
#     name: Demo cluster
#     cluster: { name: shipit-demo }
#     access: { mode: in-cluster }
#     schedule: '*/5 * * * *'
instances: []
```

Run `cd packages/shared && npx vitest run src/config/__tests__/committed-config.test.ts` to confirm the committed config still parses.

- [ ] **Step 4: Infra brief**

Create `docs/agent/briefs/infra-k8s-reader-clusterrole.md`:

```markdown
# Infra brief — read-only ClusterRole for the Kubernetes connector + demo annotations

**For:** `Ship-It-Ops/shipit-ai-infra` (Helm chart `charts/shipit-ai`).
**From:** app repo, 2026-09-16. **Enables:** the in-cluster Kubernetes connector
(`docs/superpowers/specs/2026-09-16-kubernetes-connector-design.md`, success criterion 1).

## What the app does

The api-server's scheduler runs a `kubernetes` connector that lists namespaces, nodes, pods,
deployments, replicasets, statefulsets, daemonsets, jobs and cronjobs — read-only — using the
pod's ServiceAccount when `access.mode: in-cluster`. It links workloads to GitHub repositories
via the `shipit.ai/github-repo` annotation. No new secrets: uploaded credentials ride in the
existing `shipit-connector-apps` GSM container.

## What infra needs to add

1. `charts/shipit-ai/templates/clusterrole-shipit-reader.yaml`:
   - `ClusterRole shipit-reader` with `get, list, watch` on core `namespaces, nodes, pods`;
     apps `deployments, replicasets, statefulsets, daemonsets`; batch `jobs, cronjobs`.
   - `ClusterRoleBinding shipit-reader` → `ServiceAccount {{ .Values.apiServer.serviceAccountName }}`
     in the release namespace.
2. Annotation `shipit.ai/github-repo: Ship-It-Ops/ShipIt-AI` on the four app Deployments and the
   Redis StatefulSet (pod-template annotations are not needed; the connector reads the
   workload's own metadata).
3. Nothing else: no new GSM container, no env vars, no Terraform IAM.

## Verification

After deploy: `POST /api/connectors/probe` with `{ "type": "kubernetes", "access": { "mode": "in-cluster" } }`
returns `ok: true` with every kind `ok`; create the `k8s-demo` instance and confirm 5 workload
nodes plus one `shipit-ai` LogicalService linked to the `ShipIt-AI` repository.
```

- [ ] **Step 5: Spec + agent-context reconciliation**

In the spec's **§Repository linking tiers**, replace the sentence beginning "Because the connector never queries Neo4j, "equals a repository name" is implemented as emitting the edge to the predicted id" with:

> The connector never queries Neo4j itself. At build time the api-server passes it the repository names and team slugs GitHub already synced for `githubOrg` (`knownRepositories` / `knownTeams`, source casing), so tiers 2–3 match case-insensitively and emit the predicted id with the repository's real casing. The writer's MATCH-on-both-ends drop remains the backstop.

In **§Data model** after the edge table add:

> Within one `normalize()` batch the connector keeps the highest-confidence edge per `(type, from, to)`: several workloads of one service may link the same repository at different tiers, and `mergeEdge` is last-writer-wins.

In `docs/agent/decisions/kubernetes-connector-v1-design.md` decision 4 append: "Name tiers compare against api-server-supplied known-name lists (source casing); batches keep the best edge per endpoint pair." Bump `updated`.

In `docs/agent/status/kubernetes-connector-v1.md` bump `updated`, and add under `## Why`: "Plan: `docs/superpowers/plans/2026-09-16-kubernetes-connector.md`."

- [ ] **Step 6: Full verification + commit**

Run: `pnpm install --frozen-lockfile && pnpm turbo typecheck --force && pnpm turbo test --force && pnpm turbo build --force && pnpm turbo lint --force && pnpm format:check`
Expected: all green (lint: 0 errors; the pre-existing warnings count must not grow).

```bash
git add docs README.md shipit.config.yaml
git commit -m "docs: Kubernetes connector guide, README, config example, infra brief; spec refinements"
```

Then open the PR from `k8s-connector-v1` (ask before pushing — user rule) and replace the status entry's `## Done when` with `PR #<n> merged`.

---

## Plan self-review (done while writing; kept for the executor)

**Spec coverage → task**

| Spec section                                               | Task                                                      |
| ---------------------------------------------------------- | --------------------------------------------------------- |
| Access modes, kubeconfig rules, TLS                        | 8                                                         |
| Fetch contract, paging, pod rollups, refetch seam          | 9                                                         |
| Config schema, defaults, refinements                       | 2 (+ `KUBERNETES_DEFAULT_MAPPING` in 9)                   |
| Credentials files, blob durability, upload route, probe    | 11                                                        |
| Connector-type factory, pollMode                           | 10, 11                                                    |
| Data model ids/keys/properties/claims, edges               | 6, 7                                                      |
| Service identity, linking tiers, environment, ownership    | 6, 7                                                      |
| Absence sweep: envelope, bus, emission, writer, read paths | 1, 3, 10 (emission), 4, 5                                 |
| Validation, error codes                                    | 2, 8, 9, 11                                               |
| Safety (allowlist, no secrets, read-only)                  | 8, 11                                                     |
| Testing incl. acceptance                                   | every task; 12                                            |
| Success criteria 1, 3, 4                                   | 12 (2 and 5 are manual: kind cluster + probe codes in 11) |
| Infra brief, docs, rollout                                 | 13                                                        |

**Deliberate deviations from the spec text** (both recorded in Task 13): known-name lists for tiers 2–3; best-edge-per-pair dedupe in `normalize()`.

**Type-consistency checks:** `SyncCompletedControl { kind; startedAt; mode }` is used identically in Tasks 1, 3, 10, 12. `NodeWriter.markAbsent(connectorId, startedAt, now)` matches `queries.markAbsent`. `KubernetesScopeOptions` (Task 9) equals the `scope` object Task 11 builds. `getConnectorType(...).pollMode` is read in Task 10's `start()` and defined in Tasks 10/11. `KubernetesError.status` is what the SDK harness sniffs (`err.status`).

## Execution notes

- Tasks 1–5 and 6–9 are independent streams; 10 needs 1–2, 11 needs 9–10, 12 needs 3 + 9, 13 needs everything.
- Integration and acceptance tests need `NEO4J_TEST_URI`; everything else runs offline.
- If `@kubernetes/client-node`'s generated types reject a fixture literal, fix the fixture (`satisfies`), never the normalizer types.
