import { describe, expect, it } from 'vitest';
import {
  jaro,
  jaroWinkler,
  setSimilarity,
  trigramJaccard,
} from '../../services/string-similarity.js';

describe('jaro / jaroWinkler', () => {
  it('returns 1.0 for identical strings (case + whitespace normalised)', () => {
    expect(jaroWinkler('payments-api', 'payments-api')).toBe(1);
    expect(jaroWinkler('Payments-API', '  payments-api  ')).toBe(1);
  });

  it('returns 0 for one empty input', () => {
    expect(jaro('', 'foo')).toBe(0);
    expect(jaro('foo', '')).toBe(0);
  });

  it('returns 1 for two empty inputs (vacuous equality)', () => {
    expect(jaro('', '')).toBe(1);
  });

  it('scores common typo-style mismatches high', () => {
    // payment-svc vs payment-service: clearly the same entity, abbreviation.
    expect(jaroWinkler('payments-svc', 'payments-service')).toBeGreaterThan(0.85);
  });

  it('rewards shared prefixes', () => {
    const noPrefix = jaroWinkler('martha', 'marhta');
    const sharedPrefix = jaroWinkler('dwayne', 'duane');
    expect(noPrefix).toBeGreaterThan(0.9);
    expect(sharedPrefix).toBeGreaterThan(0.8);
  });

  it('scores unrelated strings low', () => {
    expect(jaroWinkler('payments', 'redis-cache')).toBeLessThan(0.5);
  });
});

describe('trigramJaccard', () => {
  it('returns 1.0 for identical strings', () => {
    expect(trigramJaccard('payments-api', 'payments-api')).toBe(1);
  });

  it('returns 0 when only one side is empty', () => {
    expect(trigramJaccard('payments', '')).toBe(0);
  });

  it('handles partial overlap', () => {
    const score = trigramJaccard('payments-service', 'payments-svc');
    expect(score).toBeGreaterThan(0.3);
    expect(score).toBeLessThan(1);
  });
});

describe('setSimilarity', () => {
  it('returns 1.0 for empty inputs on both sides', () => {
    expect(setSimilarity([], [])).toBe(1);
  });
  it('returns 0 when one side is empty', () => {
    expect(setSimilarity(['a', 'b'], [])).toBe(0);
  });
  it('computes Jaccard on the sets', () => {
    expect(setSimilarity(['a', 'b', 'c'], ['b', 'c', 'd'])).toBeCloseTo(2 / 4);
    expect(setSimilarity(['A', 'B'], ['a', 'b'])).toBe(1); // case-insensitive
  });
});
