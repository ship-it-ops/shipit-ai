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

describe('summarizePods revision-aware digests', () => {
  const digestA = 'docker-pullable://reg/repo/api-server@sha256:' + 'a'.repeat(64);
  const digestB = 'docker-pullable://reg/repo/api-server@sha256:' + 'b'.repeat(64);
  const rsOld: V1ReplicaSet = {
    metadata: {
      name: 'api-server-old',
      annotations: { 'deployment.kubernetes.io/revision': '1' },
      ownerReferences: [
        { apiVersion: 'apps/v1', kind: 'Deployment', name: 'api-server', uid: 'u' },
      ],
    },
  } as V1ReplicaSet;
  const rsNew: V1ReplicaSet = {
    metadata: {
      name: 'api-server-new',
      annotations: { 'deployment.kubernetes.io/revision': '2' },
      ownerReferences: [
        { apiVersion: 'apps/v1', kind: 'Deployment', name: 'api-server', uid: 'u' },
      ],
    },
  } as V1ReplicaSet;

  it('attributes image digests to the newest-revision ReplicaSet only, while counting ready/restarts across all revisions', () => {
    const cache = {
      replicaSets: [rsOld, rsNew],
      pods: [
        pod('api-server-old-1', { kind: 'ReplicaSet', name: 'api-server-old' }, true, 1, digestA),
        pod('api-server-new-1', { kind: 'ReplicaSet', name: 'api-server-new' }, true, 2, digestB),
      ],
    };
    expect(summarizePods('Deployment', apiServerDeployment, cache)).toEqual({
      readyPods: 2,
      restarts: 3,
      imageDigests: { 'api-server': 'sha256:' + 'b'.repeat(64) },
    });
  });

  it('omits the digest when the newest revision itself carries disagreeing digests', () => {
    const cache = {
      replicaSets: [rsOld, rsNew],
      pods: [
        pod('api-server-new-1', { kind: 'ReplicaSet', name: 'api-server-new' }, true, 0, digestA),
        pod('api-server-new-2', { kind: 'ReplicaSet', name: 'api-server-new' }, true, 0, digestB),
      ],
    };
    expect(summarizePods('Deployment', apiServerDeployment, cache)).toEqual({
      readyPods: 2,
      restarts: 0,
      imageDigests: {},
    });
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

  it('memoizes a cluster-wide pod/replicaset rollup denial across namespaces', async () => {
    const c = clients({
      core: {
        listNamespacedPod: vi
          .fn()
          .mockRejectedValue(new ApiException(403, 'pods is forbidden', {}, {})),
      },
    });
    const f = new WorkloadFetcher(c, [demoNamespace, ns2], ['Deployment']);
    const summaries: unknown[] = [];
    let cursor: string | undefined;
    let more = true;
    while (more) {
      const r = await f.fetch(cursor);
      summaries.push(...r.entities.map((e) => (e as { pods: unknown }).pods));
      cursor = r.cursor;
      more = r.has_more;
    }
    expect(summaries).toEqual([
      { readyPods: 0, restarts: 0, imageDigests: {} },
      { readyPods: 0, restarts: 0, imageDigests: {} },
    ]);
    expect(c.core.listNamespacedPod).toHaveBeenCalledTimes(1);
    expect(f.warnings).toEqual([expect.stringMatching(/^FORBIDDEN:pods/)]);
  });
});
