import { describe, it, expect } from 'vitest';
import { connectorSubtitle } from './connector-subtitle';
import type { Connector } from './api';

const github = {
  id: 'gh-acme',
  type: 'github',
  enabled: true,
  name: 'acme',
  installationId: '123',
  org: 'acme-corp',
  schedule: '*/5 * * * *',
  scope: { repos: { include: [], exclude: [] }, teams: { include: [], exclude: [] } },
  entities: {},
  lastRuns: [],
} as unknown as Connector;

const kubernetes = {
  id: 'k8s-prod',
  type: 'kubernetes',
  enabled: true,
  name: 'prod',
  schedule: '*/5 * * * *',
  cluster: { name: 'prod-eu' },
  access: { mode: 'in-cluster' },
  scope: { namespaces: { include: ['*'], exclude: [] }, kinds: ['Deployment'] },
  lastRuns: [],
} as unknown as Connector;

describe('connectorSubtitle', () => {
  it('identifies a GitHub connector by its org', () => {
    expect(connectorSubtitle(github)).toBe('acme-corp');
  });

  it('identifies a Kubernetes connector by its cluster name', () => {
    expect(connectorSubtitle(kubernetes)).toBe('prod-eu');
  });

  // A connector type the UI does not know yet must render nothing rather than
  // the string "undefined" — which is exactly what the drawer used to show for
  // a Kubernetes connector.
  it('returns null for an unrecognised type so callers render nothing', () => {
    const future = { ...github, type: 'datadog' } as unknown as Connector;
    expect(connectorSubtitle(future)).toBeNull();
  });

  it('returns null rather than undefined when the identifying field is missing', () => {
    const malformed = { ...kubernetes, cluster: undefined } as unknown as Connector;
    expect(connectorSubtitle(malformed)).toBeNull();
  });
});
