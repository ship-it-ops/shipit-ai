import { describe, it, expect } from 'vitest';
import type { PropertyClaim } from '@shipit-ai/shared';
import { ClaimResolver } from '../claims/resolver.js';

function makeClaim(overrides: Partial<PropertyClaim> = {}): PropertyClaim {
  return {
    property_key: 'name',
    value: 'test-value',
    source: 'github',
    source_id: 'github://org/repo',
    ingested_at: '2026-02-28T10:00:00Z',
    confidence: 0.9,
    evidence: null,
    ...overrides,
  };
}

describe('ClaimResolver', () => {
  it('merges incoming claims with existing claims', () => {
    const resolver = new ClaimResolver();
    const existing = [makeClaim({ property_key: 'name', value: 'old-name', source: 'backstage' })];
    const incoming = [makeClaim({ property_key: 'name', value: 'new-name', source: 'github' })];

    const { mergedClaims } = resolver.resolve(existing, incoming);
    expect(mergedClaims).toHaveLength(2);
  });

  it('replaces claim from same source+source_id+property_key', () => {
    const resolver = new ClaimResolver();
    const existing = [
      makeClaim({
        property_key: 'name',
        value: 'old-value',
        source: 'github',
        source_id: 'github://org/repo',
      }),
    ];
    const incoming = [
      makeClaim({
        property_key: 'name',
        value: 'new-value',
        source: 'github',
        source_id: 'github://org/repo',
      }),
    ];

    const { mergedClaims } = resolver.resolve(existing, incoming);
    expect(mergedClaims).toHaveLength(1);
    expect(mergedClaims[0].value).toBe('new-value');
  });

  it('resolves effective properties using default strategy', () => {
    const resolver = new ClaimResolver();
    const existing: PropertyClaim[] = [];
    const incoming = [
      makeClaim({ property_key: 'name', value: 'my-service', confidence: 0.9 }),
      makeClaim({ property_key: 'tier', value: 1, confidence: 0.8 }),
    ];

    const { effectiveProperties } = resolver.resolve(existing, incoming);
    expect(effectiveProperties['name']).toBe('my-service');
    expect(effectiveProperties['tier']).toBe(1);
  });

  it('respects strategy overrides per property', () => {
    const resolver = new ClaimResolver({
      defaultStrategy: 'HIGHEST_CONFIDENCE',
      strategyOverrides: { tier: 'MANUAL_OVERRIDE_FIRST' },
    });

    const existing: PropertyClaim[] = [];
    const incoming = [
      makeClaim({ property_key: 'tier', value: 1, confidence: 0.95, source: 'backstage' }),
      makeClaim({ property_key: 'tier', value: 2, confidence: 0.5, source: 'manual:admin@co.com' }),
    ];

    const { effectiveProperties } = resolver.resolve(existing, incoming);
    // Manual override should win for 'tier' even with lower confidence
    expect(effectiveProperties['tier']).toBe(2);
  });

  it('groups claims by property_key', () => {
    const resolver = new ClaimResolver();
    const existing: PropertyClaim[] = [];
    const incoming = [
      makeClaim({ property_key: 'name', value: 'svc-a', confidence: 0.9 }),
      makeClaim({ property_key: 'tier', value: 1, confidence: 0.8 }),
      makeClaim({ property_key: 'name', value: 'svc-b', confidence: 0.95, source: 'backstage' }),
    ];

    const { effectiveProperties } = resolver.resolve(existing, incoming);
    // svc-b has higher confidence for name
    expect(effectiveProperties['name']).toBe('svc-b');
    expect(effectiveProperties['tier']).toBe(1);
  });

  it('resolveProperty resolves a single property', () => {
    const resolver = new ClaimResolver();
    const claims = [
      makeClaim({ value: 'a', confidence: 0.5 }),
      makeClaim({ value: 'b', confidence: 0.9 }),
    ];

    const result = resolver.resolveProperty('name', claims);
    expect(result).not.toBeNull();
    expect(result!.effective_value).toBe('b');
  });
});
