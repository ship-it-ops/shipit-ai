import type { PropertyClaim, ResolutionStrategy } from './claims.js';

export interface ResolvedProperty {
  property_key: string;
  effective_value: unknown;
  winning_claim: PropertyClaim | null;
  strategy: ResolutionStrategy;
  /** True when ≥2 sources disagree on this property. */
  has_conflict: boolean;
  claims: PropertyClaim[];
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
