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

  // Dash trimming is an index walk, not `/^-+|-+$/g` (js/polynomial-redos): a
  // long run of dashes made that regex backtrack quadratically. These pin the
  // behaviour at both edges of the input.
  it('trims dash runs at both ends without backtracking', () => {
    const run = '-'.repeat(5000);
    expect(normalizeServiceName(`a${run}`)).toBe('a');
    expect(normalizeServiceName(`${run}a${run}`)).toBe('a');
    expect(slugify(`a${run}`)).toBe('a');
    expect(slugify(`${run}a${run}`)).toBe('a');
    expect(normalizeServiceName('-----')).toBe('');
    expect(slugify('-----')).toBe('');
  });
});
