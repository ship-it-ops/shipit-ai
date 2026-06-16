import { describe, it, expect } from 'vitest';
import {
  computeEffectiveConfidence,
  computeFieldConfidence,
  deriveVerificationStatus,
} from '../utils/confidence.js';
import type { PropertyClaim } from '../types/claims.js';

const NOW = new Date('2026-06-15T00:00:00Z');
function weeksAgo(n: number): string {
  return new Date(NOW.getTime() - n * 7 * 24 * 60 * 60 * 1000).toISOString();
}
function claim(over: Partial<PropertyClaim>): PropertyClaim {
  return {
    property_key: 'name',
    value: 'api',
    source: 'github',
    source_id: 'github://org/api',
    ingested_at: NOW.toISOString(),
    confidence: 0.9,
    evidence: null,
    ...over,
  };
}

describe('computeEffectiveConfidence', () => {
  const baseDate = new Date('2026-03-01T00:00:00Z');

  it('returns base confidence for fresh claim (no decay)', () => {
    const result = computeEffectiveConfidence(0.95, '2026-03-01T00:00:00Z', baseDate);
    expect(result).toBe(0.95);
  });

  it('applies 0.01/week decay after 1 week', () => {
    const oneWeekLater = new Date('2026-03-08T00:00:00Z');
    const result = computeEffectiveConfidence(0.95, '2026-03-01T00:00:00Z', oneWeekLater);
    expect(result).toBeCloseTo(0.94, 5);
  });

  it('applies 26-week decay (0.95 -> 0.69)', () => {
    const twentySixWeeksLater = new Date(baseDate.getTime() + 26 * 7 * 24 * 60 * 60 * 1000);
    const result = computeEffectiveConfidence(0.95, '2026-03-01T00:00:00Z', twentySixWeeksLater);
    expect(result).toBeCloseTo(0.69, 2);
  });

  it('floors at 0 for very old claims', () => {
    const twoYearsLater = new Date(baseDate.getTime() + 104 * 7 * 24 * 60 * 60 * 1000);
    const result = computeEffectiveConfidence(0.5, '2026-03-01T00:00:00Z', twoYearsLater);
    expect(result).toBe(0);
  });

  it('caps at 1.0', () => {
    const result = computeEffectiveConfidence(1.5, '2026-03-01T00:00:00Z', baseDate);
    expect(result).toBe(1);
  });

  it('supports custom decay rate', () => {
    const oneWeekLater = new Date('2026-03-08T00:00:00Z');
    const result = computeEffectiveConfidence(0.95, '2026-03-01T00:00:00Z', oneWeekLater, 0.05);
    expect(result).toBeCloseTo(0.9, 5);
  });
});

describe('computeFieldConfidence', () => {
  it('S1: corroboration from an independent source raises confidence', () => {
    const github = claim({ ingested_at: weeksAgo(2) }); // 0.9, 2wk old
    const datadog = claim({ source: 'datadog', source_id: 'dd://org/api', confidence: 0.85 });
    const b = computeFieldConfidence([github, datadog], github, { now: NOW });
    // 0.90 base − 0.02 decay + 0.03 corroboration = 0.91
    expect(b.effective).toBeCloseTo(0.91, 5);
    expect(b.corroboration_sources).toEqual(['datadog']);
    expect(b.conflict).toBe(0);
  });

  it('does NOT corroborate from a derived/same-group source (login derives from github)', () => {
    const github = claim({});
    const login = claim({ source: 'login', source_id: 'login://api', confidence: 0.85 });
    const b = computeFieldConfidence([github, login], github, { now: NOW });
    expect(b.corroboration).toBe(0); // login shares SCM lineage — not an independent witness
    expect(b.effective).toBeCloseTo(0.9, 5);
  });

  it('S2: ownership ambiguity lowers confidence with more owners', () => {
    const owner = claim({ property_key: 'owner', confidence: 0.95 });
    const one = computeFieldConfidence([owner], owner, { now: NOW, ambiguityCount: 1 });
    expect(one.effective).toBeCloseTo(0.95, 5);
    const five = computeFieldConfidence([owner], owner, {
      now: NOW,
      ambiguityCount: 5,
      ambiguityReason: '5 codeowners',
    });
    // 0.95 − min(0.08*4, 0.30) = 0.95 − 0.30 = 0.65
    expect(five.effective).toBeCloseTo(0.65, 5);
    expect(five.ambiguity_reason).toBe('5 codeowners');
  });

  it('S3: a matching verified claim floors confidence even after heavy decay', () => {
    const github = claim({ ingested_at: weeksAgo(30) }); // 0.9 − 0.30 = 0.60
    const verified = claim({
      source: 'verified:mohamed@x',
      source_id: 'verified://api',
      confidence: 0.99,
      verified_by: 'mohamed@x',
      verified_at: NOW.toISOString(),
      verified_value: 'api',
    });
    const b = computeFieldConfidence([github, verified], github, { now: NOW });
    expect(b.verified).toBe(true);
    expect(b.effective).toBeCloseTo(0.98, 5); // floored
  });

  it('S4: conflict from a dissenting source lowers confidence', () => {
    const github = claim({ property_key: 'language', value: 'TypeScript' });
    const datadog = claim({
      property_key: 'language',
      value: 'JavaScript',
      source: 'datadog',
      source_id: 'dd://org/api',
      confidence: 0.85,
    });
    const b = computeFieldConfidence([github, datadog], github, { now: NOW });
    // 0.90 − 0.10 conflict = 0.80
    expect(b.effective).toBeCloseTo(0.8, 5);
    expect(b.conflict_sources).toEqual(['datadog']);
  });

  it('S5: a stale claim recovers when a fresh independent source re-asserts it', () => {
    const githubOld = claim({ ingested_at: weeksAgo(30) }); // decays to 0.60
    const datadogFresh = claim({ source: 'datadog', source_id: 'dd://org/api', confidence: 0.85 });
    // Post-decay the fresh datadog claim is the winner; github now corroborates it.
    const b = computeFieldConfidence([githubOld, datadogFresh], datadogFresh, { now: NOW });
    // 0.85 + 0.03 corroboration = 0.88
    expect(b.effective).toBeCloseTo(0.88, 5);
    expect(b.corroboration_sources).toEqual(['github']);
  });
});

describe('deriveVerificationStatus', () => {
  const base = computeFieldConfidence([claim({})], claim({}), { now: NOW });
  it('USER_VERIFIED when verified', () => {
    expect(
      deriveVerificationStatus({
        breakdown: { ...base, verified: true },
        hasConflict: false,
        isStale: false,
        needsReview: false,
      }),
    ).toBe('USER_VERIFIED');
  });
  it('DISPUTED on conflict', () => {
    expect(
      deriveVerificationStatus({
        breakdown: base,
        hasConflict: true,
        isStale: false,
        needsReview: false,
      }),
    ).toBe('DISPUTED');
  });
  it('CORROBORATED when independent sources agree', () => {
    expect(
      deriveVerificationStatus({
        breakdown: { ...base, corroboration_sources: ['datadog'] },
        hasConflict: false,
        isStale: false,
        needsReview: false,
      }),
    ).toBe('CORROBORATED');
  });
  it('STALE when old and uncorroborated', () => {
    expect(
      deriveVerificationStatus({
        breakdown: base,
        hasConflict: false,
        isStale: true,
        needsReview: false,
      }),
    ).toBe('STALE');
  });
  it('UNVERIFIED otherwise', () => {
    expect(
      deriveVerificationStatus({
        breakdown: base,
        hasConflict: false,
        isStale: false,
        needsReview: false,
      }),
    ).toBe('UNVERIFIED');
  });
});
