const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_DECAY_RATE = 0.01; // per week

export function computeEffectiveConfidence(
  baseConfidence: number,
  ingestedAt: string,
  now: Date = new Date(),
  decayRate: number = DEFAULT_DECAY_RATE,
): number {
  const ingestedDate = new Date(ingestedAt);
  const weeksSinceIngested = (now.getTime() - ingestedDate.getTime()) / MS_PER_WEEK;
  const decayed = baseConfidence - decayRate * weeksSinceIngested;
  return Math.max(0, Math.min(1, decayed));
}
