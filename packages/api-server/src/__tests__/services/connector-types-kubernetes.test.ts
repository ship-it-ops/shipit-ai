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
    const warn = vi.fn();
    const built = await type.build(
      k8s({ mode: 'in-cluster' }),
      ctx({
        listConnectors: () => [gh('a', 'acme')],
        lookupRepositoryNames: async () => {
          throw new Error('neo4j down');
        },
        logger: { warn },
      }),
    );
    if (!built.ok) throw new Error(built.message);
    expect(built.sdkConfig.scope).toMatchObject({
      githubOrg: 'acme',
      knownRepositories: [],
      knownTeams: [],
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('graph lookups failed'),
      expect.objectContaining({ err: 'neo4j down' }),
    );
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

  it('probe pages the namespace pods and replicasets ONCE for all four kinds', async () => {
    const clients = fakeClients();
    const type = makeKubernetesConnectorType(() => clients);
    await type.probe!(
      { type: 'kubernetes', access: { mode: 'token', server: 'https://h', token: 't' } },
      ctx(),
    );
    // One shared WorkloadFetcher: a fetcher per kind re-paged every pod of the
    // target namespace for each of Deployment / StatefulSet / DaemonSet.
    expect(clients.core.listNamespacedPod).toHaveBeenCalledTimes(1);
    expect(clients.apps.listNamespacedReplicaSet).toHaveBeenCalledTimes(1);
  });

  it('probe gives up on the overall budget even when every single call is under its own timeout', async () => {
    vi.useFakeTimers();
    try {
      // 25 s each: none trips the 30 s per-call timeout, three in series trip the 60 s budget.
      const slow =
        <T>(value: T) =>
        () =>
          new Promise<T>((resolve) => setTimeout(() => resolve(value), 25_000));
      const clients = fakeClients({
        version: { getCode: vi.fn().mockImplementation(slow({ gitVersion: 'v1.31.2' })) },
        core: {
          listNamespace: vi.fn().mockImplementation(slow(list([{ metadata: { name: 'shipit' } }]))),
          readNamespace: vi.fn(),
          listNode: vi.fn().mockImplementation(slow(list([]))),
          listNamespacedPod: vi.fn().mockImplementation(slow(list([]))),
        },
      });
      const type = makeKubernetesConnectorType(() => clients);
      const pending = type.probe!(
        { type: 'kubernetes', access: { mode: 'token', server: 'https://h', token: 't' } },
        ctx(),
      );
      await vi.advanceTimersByTimeAsync(90_000);
      const r = await pending;
      expect(r).toMatchObject({ ok: false, code: 'TIMEOUT' });
      expect(String((r as { message: string }).message)).toContain('connection probe');
    } finally {
      vi.useRealTimers();
    }
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
