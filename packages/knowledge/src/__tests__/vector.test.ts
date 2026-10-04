import { describe, it, expect } from 'vitest';
import { toPgVector } from '../vector.js';

describe('toPgVector', () => {
  it('formats a pgvector literal', () => {
    expect(toPgVector([0.5, -1, 2.25])).toBe('[0.5,-1,2.25]');
    expect(toPgVector(new Float32Array([1, 0]))).toBe('[1,0]');
  });
  it('rejects NaN and Infinity', () => {
    expect(() => toPgVector([1, Number.NaN])).toThrow(/finite/);
  });
});
