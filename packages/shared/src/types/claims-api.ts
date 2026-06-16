import type { PropertyClaim, ResolutionStrategy } from './claims.js';

/** Per-field verification lifecycle, derived from claims + timestamps (not stored). */
export type VerificationStatus =
  | 'UNVERIFIED'
  | 'CORROBORATED'
  | 'USER_VERIFIED'
  | 'DISPUTED'
  | 'STALE';

/** One named, signed contribution to a field's confidence, for explainable UI. */
export interface BreakdownTerm {
  label: string;
  delta: number;
}

/**
 * Explainable decomposition of a field's effective confidence. Renders as a
 * sentence: "0.90 base (github) − 0.02 decay + 0.03 corroborated by datadog = 0.91".
 */
export interface ConfidenceBreakdown {
  base: number;
  base_source: string;
  decay: number;
  corroboration: number;
  corroboration_sources: string[];
  conflict: number;
  conflict_sources: string[];
  ambiguity: number;
  ambiguity_reason?: string;
  verified: boolean;
  verified_by?: string | null;
  effective: number;
  terms: BreakdownTerm[];
}

export interface ResolvedProperty {
  property_key: string;
  effective_value: unknown;
  winning_claim: PropertyClaim | null;
  strategy: ResolutionStrategy;
  /** True when ≥2 sources disagree on this property. */
  has_conflict: boolean;
  claims: PropertyClaim[];
  /** Effective confidence (== breakdown.effective), 0..1. */
  confidence: number;
  breakdown: ConfidenceBreakdown;
  status: VerificationStatus;
  /** A verified value is contradicted by a newer sync and awaits re-review. */
  needs_review: boolean;
}

export interface EntityClaims {
  entityId: string;
  label: string;
  name: string;
  properties: ResolvedProperty[];
}

export interface ConflictRow {
  entityId: string;
  name: string;
  label: string;
  tier: number | null;
  propertyKey: string;
  sources: string[];
  values: unknown[];
  claimCount: number;
}
