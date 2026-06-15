import { describe, it, expect } from 'vitest';
import {
  buildCanonicalId,
  buildScopedCanonicalId,
  buildPersonCanonicalId,
  parseCanonicalId,
  isValidCanonicalId,
} from '../identity/canonical-id.js';

describe('buildCanonicalId', () => {
  it('builds from PascalCase label', () => {
    expect(buildCanonicalId('LogicalService', 'default', 'graph-api')).toBe(
      'shipit://logical-service/default/graph-api',
    );
  });

  it('builds from simple label', () => {
    expect(buildCanonicalId('Repository', 'default', 'config-service')).toBe(
      'shipit://repository/default/config-service',
    );
  });

  it('builds from multi-word PascalCase label', () => {
    expect(buildCanonicalId('RuntimeService', 'prod', 'api-gateway')).toBe(
      'shipit://runtime-service/prod/api-gateway',
    );
  });

  it('preserves already lowercase label', () => {
    expect(buildCanonicalId('team', 'default', 'platform')).toBe('shipit://team/default/platform');
  });
});

describe('buildScopedCanonicalId', () => {
  it('adds a scope segment between namespace and name', () => {
    expect(buildScopedCanonicalId('Repository', 'default', 'shipitops', 'graph-api')).toBe(
      'shipit://repository/default/shipitops/graph-api',
    );
  });

  it('builds scoped Team IDs', () => {
    expect(buildScopedCanonicalId('Team', 'default', 'shipitops', 'platform')).toBe(
      'shipit://team/default/shipitops/platform',
    );
  });

  it('round-trips through parseCanonicalId with the scope baked into name', () => {
    const id = buildScopedCanonicalId('Repository', 'default', 'shipitops', 'graph-api');
    expect(parseCanonicalId(id)).toEqual({
      label: 'repository',
      namespace: 'default',
      name: 'shipitops/graph-api',
    });
  });

  it('produces distinct IDs for the same name in different scopes', () => {
    const a = buildScopedCanonicalId('Repository', 'default', 'shipitops', 'infra');
    const b = buildScopedCanonicalId('Repository', 'default', 'cargocloud', 'infra');
    expect(a).not.toBe(b);
  });
});

describe('buildPersonCanonicalId', () => {
  it('lowercases the login so case never blocks a merge', () => {
    // GitHub logins are case-insensitive + globally unique. A login with
    // uppercase (the connector emits GitHub's stored case) must resolve to
    // the same id as the login upsert (which keys off the same login).
    expect(buildPersonCanonicalId('Mohamed-E')).toBe('shipit://person/default/mohamed-e');
  });

  it('matches across casings — connector and login Person ids converge', () => {
    expect(buildPersonCanonicalId('Mohamed-E')).toBe(buildPersonCanonicalId('mohamed-e'));
  });

  it('leaves already-lowercase logins unchanged', () => {
    expect(buildPersonCanonicalId('alice')).toBe('shipit://person/default/alice');
  });
});

describe('parseCanonicalId', () => {
  it('parses valid canonical ID', () => {
    const result = parseCanonicalId('shipit://logical-service/default/graph-api');
    expect(result).toEqual({
      label: 'logical-service',
      namespace: 'default',
      name: 'graph-api',
    });
  });

  it('parses ID with complex name', () => {
    const result = parseCanonicalId('shipit://repository/default/my-org/my-repo');
    expect(result).toEqual({
      label: 'repository',
      namespace: 'default',
      name: 'my-org/my-repo',
    });
  });

  it('returns null for invalid ID', () => {
    expect(parseCanonicalId('invalid')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseCanonicalId('')).toBeNull();
  });

  it('returns null for ID without shipit prefix', () => {
    expect(parseCanonicalId('http://repository/default/repo')).toBeNull();
  });
});

describe('isValidCanonicalId', () => {
  it('validates correct format', () => {
    expect(isValidCanonicalId('shipit://repository/default/my-repo')).toBe(true);
  });

  it('validates multi-segment name', () => {
    expect(isValidCanonicalId('shipit://logical-service/default/graph-api')).toBe(true);
  });

  it('rejects invalid format', () => {
    expect(isValidCanonicalId('not-a-valid-id')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidCanonicalId('')).toBe(false);
  });
});
