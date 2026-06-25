import { describe, it, expect } from 'vitest';
import type { PropertyClaim } from '@shipit-ai/shared';
import { resolveClaims } from '../claims/strategies.js';

function makeClaim(overrides: Partial<PropertyClaim> = {}): PropertyClaim {
  return {
    property_key: 'tier',
    value: 1,
    source: 'github',
    source_id: 'github://org/repo',
    ingested_at: '2026-02-28T10:00:00Z',
    confidence: 0.9,
    evidence: null,
    ...overrides,
  };
}

describe('resolveClaims', () => {
  it('returns null for empty claims', () => {
    expect(resolveClaims([], 'HIGHEST_CONFIDENCE')).toBeNull();
  });

  describe('HIGHEST_CONFIDENCE', () => {
    it('picks the claim with highest confidence', () => {
      const claims = [
        makeClaim({ value: 'low', confidence: 0.5 }),
        makeClaim({ value: 'high', confidence: 0.95 }),
        makeClaim({ value: 'mid', confidence: 0.7 }),
      ];
      const result = resolveClaims(claims, 'HIGHEST_CONFIDENCE');
      expect(result!.effective_value).toBe('high');
      expect(result!.winning_claim.confidence).toBe(0.95);
    });

    it('breaks ties by most recent ingestion', () => {
      const claims = [
        makeClaim({ value: 'old', confidence: 0.9, ingested_at: '2026-02-20T10:00:00Z' }),
        makeClaim({ value: 'new', confidence: 0.9, ingested_at: '2026-02-28T10:00:00Z' }),
      ];
      const result = resolveClaims(claims, 'HIGHEST_CONFIDENCE');
      expect(result!.effective_value).toBe('new');
    });

    it('applies confidence decay', () => {
      const now = new Date('2026-04-01T00:00:00Z'); // ~4.4 weeks later
      const claims = [
        makeClaim({
          value: 'old-high',
          confidence: 0.9,
          ingested_at: '2026-02-01T10:00:00Z', // ~8.3 weeks old -> 0.9 - 0.01*8.3 = ~0.817
        }),
        makeClaim({
          value: 'recent-lower',
          confidence: 0.85,
          ingested_at: '2026-03-28T10:00:00Z', // ~0.5 weeks old -> ~0.845
        }),
      ];
      const result = resolveClaims(claims, 'HIGHEST_CONFIDENCE', 0.01, now);
      expect(result!.effective_value).toBe('recent-lower');
    });
  });

  describe('MANUAL_OVERRIDE_FIRST', () => {
    it('picks manual claim even if lower confidence', () => {
      const claims = [
        makeClaim({ value: 'auto', confidence: 0.95, source: 'github' }),
        makeClaim({ value: 'manual', confidence: 0.5, source: 'manual:admin@co.com' }),
      ];
      const result = resolveClaims(claims, 'MANUAL_OVERRIDE_FIRST');
      expect(result!.effective_value).toBe('manual');
      expect(result!.strategy).toBe('MANUAL_OVERRIDE_FIRST');
    });

    it('falls back to highest confidence when no manual claim', () => {
      const claims = [
        makeClaim({ value: 'low', confidence: 0.5 }),
        makeClaim({ value: 'high', confidence: 0.95 }),
      ];
      const result = resolveClaims(claims, 'MANUAL_OVERRIDE_FIRST');
      expect(result!.effective_value).toBe('high');
      expect(result!.strategy).toBe('MANUAL_OVERRIDE_FIRST');
    });

    it('among two manual claims, freshest wins deterministically (array-order independent)', () => {
      const older = makeClaim({
        value: 'alice',
        source: 'manual:alice@co.com',
        ingested_at: '2026-01-01T00:00:00.000Z',
      });
      const newer = makeClaim({
        value: 'bob',
        source: 'manual:bob@co.com',
        ingested_at: '2026-02-01T00:00:00.000Z',
      });
      // Same winner regardless of input order — the read path (api-server) agrees.
      expect(resolveClaims([older, newer], 'MANUAL_OVERRIDE_FIRST')!.effective_value).toBe('bob');
      expect(resolveClaims([newer, older], 'MANUAL_OVERRIDE_FIRST')!.effective_value).toBe('bob');
    });
  });

  describe('AUTHORITATIVE_ORDER', () => {
    it('uses predefined source priority: manual > backstage > github', () => {
      const claims = [
        makeClaim({ value: 'from-github', source: 'github' }),
        makeClaim({ value: 'from-backstage', source: 'backstage' }),
      ];
      const result = resolveClaims(claims, 'AUTHORITATIVE_ORDER');
      expect(result!.effective_value).toBe('from-backstage');
    });

    it('manual source wins over all', () => {
      const claims = [
        makeClaim({ value: 'from-backstage', source: 'backstage' }),
        makeClaim({ value: 'from-manual', source: 'manual:user' }),
      ];
      const result = resolveClaims(claims, 'AUTHORITATIVE_ORDER');
      expect(result!.effective_value).toBe('from-manual');
    });

    it('unknown sources sort to the end', () => {
      const claims = [
        makeClaim({ value: 'from-unknown', source: 'custom-source' }),
        makeClaim({ value: 'from-jira', source: 'jira' }),
      ];
      const result = resolveClaims(claims, 'AUTHORITATIVE_ORDER');
      expect(result!.effective_value).toBe('from-jira');
    });
  });

  describe('LATEST_TIMESTAMP', () => {
    it('picks the most recently ingested claim', () => {
      const claims = [
        makeClaim({ value: 'old', ingested_at: '2026-02-01T10:00:00Z' }),
        makeClaim({ value: 'newest', ingested_at: '2026-02-28T10:00:00Z' }),
        makeClaim({ value: 'middle', ingested_at: '2026-02-15T10:00:00Z' }),
      ];
      const result = resolveClaims(claims, 'LATEST_TIMESTAMP');
      expect(result!.effective_value).toBe('newest');
    });
  });

  describe('MERGE_SET', () => {
    it('merges scalar values into a set', () => {
      const claims = [
        makeClaim({ value: 'tag-a' }),
        makeClaim({ value: 'tag-b' }),
        makeClaim({ value: 'tag-a' }), // duplicate
      ];
      const result = resolveClaims(claims, 'MERGE_SET');
      const values = result!.effective_value as string[];
      expect(values).toHaveLength(2);
      expect(values).toContain('tag-a');
      expect(values).toContain('tag-b');
    });

    it('merges array values', () => {
      const claims = [makeClaim({ value: ['a', 'b'] }), makeClaim({ value: ['b', 'c'] })];
      const result = resolveClaims(claims, 'MERGE_SET');
      const values = result!.effective_value as string[];
      expect(values).toHaveLength(3);
      expect(values).toContain('a');
      expect(values).toContain('b');
      expect(values).toContain('c');
    });
  });

  it('returns all_claims in result', () => {
    const claims = [makeClaim(), makeClaim({ source: 'backstage' })];
    const result = resolveClaims(claims, 'HIGHEST_CONFIDENCE');
    expect(result!.all_claims).toHaveLength(2);
  });
});
