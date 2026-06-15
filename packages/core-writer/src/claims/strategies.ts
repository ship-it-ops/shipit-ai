import type { PropertyClaim, ResolutionStrategy, ClaimResolutionResult } from '@shipit-ai/shared';
import { computeEffectiveConfidence } from '@shipit-ai/shared';

export function resolveClaims(
  claims: PropertyClaim[],
  strategy: ResolutionStrategy,
  decayRate?: number,
  now?: Date,
): ClaimResolutionResult | null {
  if (claims.length === 0) return null;

  switch (strategy) {
    case 'MANUAL_OVERRIDE_FIRST':
      return resolveManualOverrideFirst(claims, decayRate, now);
    case 'HIGHEST_CONFIDENCE':
      return resolveHighestConfidence(claims, decayRate, now);
    case 'AUTHORITATIVE_ORDER':
      return resolveAuthoritativeOrder(claims);
    case 'LATEST_TIMESTAMP':
      return resolveLatestTimestamp(claims);
    case 'MERGE_SET':
      return resolveMergeSet(claims);
  }
}

function resolveManualOverrideFirst(
  claims: PropertyClaim[],
  decayRate?: number,
  now?: Date,
): ClaimResolutionResult {
  const manualClaim = claims.find((c) => c.source.startsWith('manual:'));
  if (manualClaim) {
    return {
      effective_value: manualClaim.value,
      winning_claim: manualClaim,
      strategy: 'MANUAL_OVERRIDE_FIRST',
      all_claims: claims,
    };
  }
  // Fall back to highest confidence
  const result = resolveHighestConfidence(claims, decayRate, now);
  return { ...result, strategy: 'MANUAL_OVERRIDE_FIRST' };
}

function resolveHighestConfidence(
  claims: PropertyClaim[],
  decayRate?: number,
  now?: Date,
): ClaimResolutionResult {
  const scored = claims.map((c) => ({
    claim: c,
    effective: computeEffectiveConfidence(c.confidence, c.ingested_at, now, decayRate),
  }));
  scored.sort((a, b) => {
    if (b.effective !== a.effective) return b.effective - a.effective;
    // Tiebreak: most recent ingestion wins
    return new Date(b.claim.ingested_at).getTime() - new Date(a.claim.ingested_at).getTime();
  });
  const winner = scored[0].claim;
  return {
    effective_value: winner.value,
    winning_claim: winner,
    strategy: 'HIGHEST_CONFIDENCE',
    all_claims: claims,
  };
}

const SOURCE_PRIORITY = [
  'manual',
  'backstage',
  'github',
  // Authenticated-login self-claims rank just below the GitHub connector, so
  // the connector wins overlapping fields while login fills gaps it lacks.
  'login',
  'kubernetes',
  'datadog',
  'jira',
  'identity',
];

function resolveAuthoritativeOrder(claims: PropertyClaim[]): ClaimResolutionResult {
  const sorted = [...claims].sort((a, b) => {
    const aIdx = SOURCE_PRIORITY.findIndex((p) => a.source.startsWith(p));
    const bIdx = SOURCE_PRIORITY.findIndex((p) => b.source.startsWith(p));
    return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
  });
  const winner = sorted[0];
  return {
    effective_value: winner.value,
    winning_claim: winner,
    strategy: 'AUTHORITATIVE_ORDER',
    all_claims: claims,
  };
}

function resolveLatestTimestamp(claims: PropertyClaim[]): ClaimResolutionResult {
  const sorted = [...claims].sort(
    (a, b) => new Date(b.ingested_at).getTime() - new Date(a.ingested_at).getTime(),
  );
  const winner = sorted[0];
  return {
    effective_value: winner.value,
    winning_claim: winner,
    strategy: 'LATEST_TIMESTAMP',
    all_claims: claims,
  };
}

function resolveMergeSet(claims: PropertyClaim[]): ClaimResolutionResult {
  const allValues = new Set<string>();
  for (const claim of claims) {
    if (Array.isArray(claim.value)) {
      for (const v of claim.value) {
        allValues.add(String(v));
      }
    } else {
      allValues.add(String(claim.value));
    }
  }
  const mergedValue = Array.from(allValues);
  return {
    effective_value: mergedValue,
    winning_claim: claims[0],
    strategy: 'MERGE_SET',
    all_claims: claims,
  };
}
