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
