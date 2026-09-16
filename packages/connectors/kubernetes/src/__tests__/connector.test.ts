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
    expect((await badScope.authenticate(config({ cluster: '' }))).error).toMatch(
      /^SCOPE_INVALID: scope\.cluster/,
    );
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

  it('refetchWorkload classifies failures the same way fetch() does', async () => {
    const c = new KubernetesConnector(() =>
      fakeClients({
        apps: {
          listNamespacedDeployment: vi
            .fn()
            .mockRejectedValue(new ApiException(403, 'deployments is forbidden', {}, {})),
          listNamespacedStatefulSet: vi.fn().mockResolvedValue(list([])),
          listNamespacedDaemonSet: vi.fn().mockResolvedValue(list([])),
          listNamespacedReplicaSet: vi.fn().mockResolvedValue(list([])),
        },
      }),
    );
    await c.authenticate(config());
    await expect(c.refetchWorkload('shipit', 'Deployment', 'api-server')).rejects.toMatchObject({
      code: 'FORBIDDEN',
      status: 403,
    });
  });
});
