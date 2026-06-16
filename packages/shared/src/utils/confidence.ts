import type { PropertyClaim } from '../types/claims.js';
import type {
  BreakdownTerm,
  ConfidenceBreakdown,
  VerificationStatus,
} from '../types/claims-api.js';
import {
  getSourceReliability,
  independenceGroup,
  isDerivedFrom,
  sourceKey,
} from '../config/source-reliability.js';

const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_DECAY_RATE = 0.01; // per week

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** Weeks elapsed since a claim was ingested (never negative). */
export function weeksSince(ingestedAt: string, now: Date = new Date()): number {
  const weeks = (now.getTime() - new Date(ingestedAt).getTime()) / MS_PER_WEEK;
  return Math.max(0, weeks);
}

/** Confidence lost to time-decay (the subtractive term), before clamping. */
export function decayLoss(
  ingestedAt: string,
  now: Date = new Date(),
  decayRate: number = DEFAULT_DECAY_RATE,
): number {
  return decayRate * weeksSince(ingestedAt, now);
}

export function computeEffectiveConfidence(
  baseConfidence: number,
  ingestedAt: string,
  now: Date = new Date(),
  decayRate: number = DEFAULT_DECAY_RATE,
): number {
  return clamp01(baseConfidence - decayLoss(ingestedAt, now, decayRate));
}

/** Tunable constants for the heuristic per-field confidence engine. */
export interface ConfidenceTuning {
  decayRate: number;
  corrobPer: number;
  corrobCap: number;
  conflictBase: number;
  conflictPer: number;
  ambigPer: number;
  ambigCap: number;
  verifiedFloor: number;
  /** Weeks after which a non-verified field is considered STALE. */
  staleWeeks: number;
}

export const DEFAULT_CONFIDENCE_TUNING: ConfidenceTuning = {
  decayRate: 0.01,
  corrobPer: 0.03,
  corrobCap: 0.08,
  conflictBase: 0.1,
  conflictPer: 0.05,
  ambigPer: 0.08,
  ambigCap: 0.3,
  verifiedFloor: 0.98,
  staleWeeks: 12,
};

function valuesEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export interface FieldConfidenceOptions {
  now?: Date;
  tuning?: ConfidenceTuning;
  /**
   * Count of distinct values asserted by a single source for a single-valued
   * field (the multiplicity/ambiguity signal, e.g. number of codeowners). >1
   * lowers confidence. Distinct from cross-source corroboration.
   */
  ambiguityCount?: number;
  ambiguityReason?: string;
}

/**
 * Compute a per-field effective confidence + explainable breakdown from a claim
 * group and the resolution winner. The SAME function runs on both the write path
 * (snapshot) and the read path (display) so the two never diverge.
 *
 * effective = clamp(base − decay + corrob − conflict − ambiguity, 0, 1),
 * then floored to `verifiedFloor` when a matching `verified:` claim exists.
 */
export function computeFieldConfidence(
  group: PropertyClaim[],
  winner: PropertyClaim,
  options: FieldConfidenceOptions = {},
): ConfidenceBreakdown {
  const now = options.now ?? new Date();
  const t = options.tuning ?? DEFAULT_CONFIDENCE_TUNING;

  const base = winner.confidence;
  const winnerEntry = getSourceReliability(winner.source);
  const decay = winnerEntry.decays ? decayLoss(winner.ingested_at, now, t.decayRate) : 0;

  const agreeing = group.filter((c) => valuesEqual(c.value, winner.value));
  const disagreeing = group.filter((c) => !valuesEqual(c.value, winner.value));

  // Corroboration: count distinct INDEPENDENT groups among agreeing sources,
  // excluding the winner's own group and any lineage derived from the winner.
  const corrobGroups = new Set<string>();
  const corrobSources: string[] = [];
  for (const c of agreeing) {
    if (sourceKey(c.source) === sourceKey(winner.source)) continue;
    if (isDerivedFrom(c.source, winner.source)) continue;
    const grp = independenceGroup(c.source);
    if (!corrobGroups.has(grp)) {
      corrobGroups.add(grp);
      corrobSources.push(c.source);
    }
  }
  const corroboration = Math.min(t.corrobPer * corrobGroups.size, t.corrobCap);

  // Conflict: scaled by distinct dissenting independence groups.
  const dissentGroups = new Set<string>();
  const conflictSources: string[] = [];
  for (const c of disagreeing) {
    const grp = independenceGroup(c.source);
    if (!dissentGroups.has(grp)) {
      dissentGroups.add(grp);
      conflictSources.push(c.source);
    }
  }
  const conflict =
    dissentGroups.size === 0 ? 0 : t.conflictBase + t.conflictPer * (dissentGroups.size - 1);

  // Ambiguity: single-source multiplicity on a single-valued field.
  const ambiguityCount = options.ambiguityCount ?? 0;
  const ambiguity =
    ambiguityCount > 1 ? Math.min(t.ambigPer * (ambiguityCount - 1), t.ambigCap) : 0;

  let effective = clamp01(base - decay + corroboration - conflict - ambiguity);

  // Verification override (value-bound): a `verified:` claim matching the winner
  // floors the confidence. Verification is what makes the value "assured".
  const verifiedClaim = group.find(
    (c) =>
      sourceKey(c.source) === 'verified' && valuesEqual(c.verified_value ?? c.value, winner.value),
  );
  const verified = Boolean(verifiedClaim);
  let verifiedBump = 0;
  if (verified && effective < t.verifiedFloor) {
    verifiedBump = t.verifiedFloor - effective;
    effective = t.verifiedFloor;
  }

  const terms: BreakdownTerm[] = [{ label: `base (${winner.source})`, delta: base }];
  if (decay > 0) terms.push({ label: 'decay', delta: -decay });
  if (corroboration > 0)
    terms.push({ label: `corroborated by ${corrobSources.join(', ')}`, delta: corroboration });
  if (conflict > 0)
    terms.push({ label: `conflict (${conflictSources.join(', ')})`, delta: -conflict });
  if (ambiguity > 0)
    terms.push({
      label: options.ambiguityReason ?? `ambiguity (${ambiguityCount})`,
      delta: -ambiguity,
    });
  if (verifiedBump > 0) terms.push({ label: 'verified floor', delta: verifiedBump });

  return {
    base,
    base_source: winner.source,
    decay,
    corroboration,
    corroboration_sources: corrobSources,
    conflict,
    conflict_sources: conflictSources,
    ambiguity,
    ambiguity_reason: ambiguity > 0 ? options.ambiguityReason : undefined,
    verified,
    verified_by: verifiedClaim?.verified_by ?? null,
    effective,
    terms,
  };
}

export interface VerificationStatusInput {
  breakdown: ConfidenceBreakdown;
  hasConflict: boolean;
  isStale: boolean;
  needsReview: boolean;
}

/** Derive the user-facing verification status from the computed signals. */
export function deriveVerificationStatus(input: VerificationStatusInput): VerificationStatus {
  if (input.breakdown.verified) return 'USER_VERIFIED';
  if (input.hasConflict) return 'DISPUTED';
  if (input.isStale) return 'STALE';
  if (input.breakdown.corroboration_sources.length > 0) return 'CORROBORATED';
  return 'UNVERIFIED';
}
