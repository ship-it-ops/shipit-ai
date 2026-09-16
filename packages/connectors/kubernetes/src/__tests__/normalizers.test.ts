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
