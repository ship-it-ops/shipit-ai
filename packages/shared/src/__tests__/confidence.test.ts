import { describe, it, expect } from 'vitest';
import { computeEffectiveConfidence } from '../utils/confidence.js';

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
