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
