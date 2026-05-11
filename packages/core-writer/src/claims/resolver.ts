import type { PropertyClaim, ResolutionStrategy, ClaimResolutionResult } from '@shipit-ai/shared';
import { resolveClaims } from './strategies.js';

export interface ResolverOptions {
  defaultStrategy: ResolutionStrategy;
  strategyOverrides: Record<string, ResolutionStrategy>;
  decayRate?: number;
}

const DEFAULT_RESOLVER_OPTIONS: ResolverOptions = {
  defaultStrategy: 'HIGHEST_CONFIDENCE',
  strategyOverrides: {},
  decayRate: 0.01,
};

export class ClaimResolver {
  private readonly options: ResolverOptions;

  constructor(options?: Partial<ResolverOptions>) {
    this.options = { ...DEFAULT_RESOLVER_OPTIONS, ...options };
  }

  resolve(
    existingClaims: PropertyClaim[],
    incomingClaims: PropertyClaim[],
    now?: Date,
  ): {
    mergedClaims: PropertyClaim[];
    effectiveProperties: Record<string, unknown>;
  } {
    // Merge existing + incoming claims
    const mergedClaims = this.mergeClaims(existingClaims, incomingClaims);

    // Group claims by property_key
    const claimsByProperty = new Map<string, PropertyClaim[]>();
    for (const claim of mergedClaims) {
      const existing = claimsByProperty.get(claim.property_key) ?? [];
      existing.push(claim);
      claimsByProperty.set(claim.property_key, existing);
    }

    // Resolve each property
    const effectiveProperties: Record<string, unknown> = {};
    for (const [propertyKey, claims] of claimsByProperty) {
      const strategy = this.options.strategyOverrides[propertyKey] ?? this.options.defaultStrategy;
      const result = resolveClaims(claims, strategy, this.options.decayRate, now);
      if (result) {
        effectiveProperties[propertyKey] = result.effective_value;
      }
    }

    return { mergedClaims, effectiveProperties };
  }

  resolveProperty(
    propertyKey: string,
    claims: PropertyClaim[],
    now?: Date,
  ): ClaimResolutionResult | null {
    const strategy = this.options.strategyOverrides[propertyKey] ?? this.options.defaultStrategy;
    return resolveClaims(claims, strategy, this.options.decayRate, now);
  }

  private mergeClaims(existing: PropertyClaim[], incoming: PropertyClaim[]): PropertyClaim[] {
    const merged = [...existing];

    for (const claim of incoming) {
      // Replace claim from same source+source_id+property_key, or add new
      const idx = merged.findIndex(
        (c) =>
          c.source === claim.source &&
          c.source_id === claim.source_id &&
          c.property_key === claim.property_key,
      );
      if (idx >= 0) {
        merged[idx] = claim;
      } else {
        merged.push(claim);
      }
    }

    return merged;
  }
}
