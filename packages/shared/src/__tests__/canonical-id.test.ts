import { describe, it, expect } from 'vitest';
import {
  buildCanonicalId,
  parseCanonicalId,
  isValidCanonicalId,
} from '../identity/canonical-id.js';

describe('buildCanonicalId', () => {
  it('builds from PascalCase label', () => {
    expect(buildCanonicalId('LogicalService', 'default', 'payments-api')).toBe(
      'shipit://logical-service/default/payments-api',
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

describe('parseCanonicalId', () => {
  it('parses valid canonical ID', () => {
    const result = parseCanonicalId('shipit://logical-service/default/payments-api');
    expect(result).toEqual({
      label: 'logical-service',
      namespace: 'default',
      name: 'payments-api',
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
    expect(isValidCanonicalId('shipit://logical-service/default/payments-api')).toBe(true);
  });

  it('rejects invalid format', () => {
    expect(isValidCanonicalId('not-a-valid-id')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidCanonicalId('')).toBe(false);
  });
});
