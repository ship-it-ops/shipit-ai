import { describe, it, expect } from 'vitest';
import type { PropertyClaim } from '../index.js';
import { pickManualOverride } from '../index.js';

function claim(over: Partial<PropertyClaim>): PropertyClaim {
  return {
    property_key: 'name',
    value: 'x',
    source: 'github',
    source_id: 'github://x',
    ingested_at: '2026-01-01T00:00:00.000Z',
    confidence: 0.9,
    evidence: null,
    ...over,
  };
}

describe('pickManualOverride (shared deterministic resolver)', () => {
  it('returns null when no verified/manual claim exists', () => {
    expect(
      pickManualOverride([claim({ source: 'github' }), claim({ source: 'datadog' })]),
    ).toBeNull();
  });

  it('verified outranks manual', () => {
    const verified = claim({ source: 'verified:bob@x', value: 'V' });
    const manual = claim({
      source: 'manual:alice@x',
      value: 'M',
      ingested_at: '2026-12-01T00:00:00.000Z', // newer, but lower priority rank
    });
    expect(pickManualOverride([manual, verified])!.value).toBe('V');
    // Stable regardless of array order.
    expect(pickManualOverride([verified, manual])!.value).toBe('V');
  });

  it('ignores connector claims and picks the manual override', () => {
    const manual = claim({ source: 'manual:alice@x', value: 'M' });
    expect(pickManualOverride([claim({ source: 'github', value: 'G' }), manual])!.value).toBe('M');
  });

  it('among same-rank manual claims, freshest ingested_at wins — and is order-independent', () => {
    const older = claim({
      source: 'manual:alice@x',
      value: 'alice',
      ingested_at: '2026-01-01T00:00:00.000Z',
    });
    const newer = claim({
      source: 'manual:bob@x',
      value: 'bob',
      ingested_at: '2026-02-01T00:00:00.000Z',
    });
    expect(pickManualOverride([older, newer])!.value).toBe('bob');
    expect(pickManualOverride([newer, older])!.value).toBe('bob');
  });

  it('final tie-break is source lexicographic when rank and ingested_at are equal', () => {
    const ts = '2026-03-03T00:00:00.000Z';
    const a = claim({ source: 'manual:aaa@x', value: 'A', ingested_at: ts });
    const z = claim({ source: 'manual:zzz@x', value: 'Z', ingested_at: ts });
    // 'manual:aaa@x' < 'manual:zzz@x' lexicographically → A wins, both orders.
    expect(pickManualOverride([a, z])!.value).toBe('A');
    expect(pickManualOverride([z, a])!.value).toBe('A');
  });
});
