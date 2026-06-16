// Phase 2: Claim Explorer backend.
// Reads PropertyClaim[] JSON stored on each node's `_claims` property, groups
// by property_key, and applies the entity-type's resolution_strategy to pick
// the winning claim. Surfaces conflicts (>= 2 distinct values) for the
// dashboard view.
import type { PropertyClaim, ResolutionStrategy, ShipItSchema } from '@shipit-ai/shared';
import type { ConflictRow, EntityClaims, ResolvedProperty } from '@shipit-ai/shared';
import {
  computeEffectiveConfidence,
  computeFieldConfidence,
  deriveVerificationStatus,
  sourceKey,
  sourceRank,
  weeksSince,
  DEFAULT_CONFIDENCE_TUNING,
} from '@shipit-ai/shared';
import type { Neo4jService } from './neo4j-service.js';
import type { SchemaService } from './schema-service.js';

function pickByStrategy(
  claims: PropertyClaim[],
  strategy: ResolutionStrategy,
  now: Date,
): { winner: PropertyClaim | null; effective: unknown } {
  if (claims.length === 0) return { winner: null, effective: null };

  if (strategy === 'MANUAL_OVERRIDE_FIRST') {
    // Human attestation wins: `verified:<user>` outranks `manual:<user>`.
    // Matches core-writer's resolveManualOverrideFirst (prefix match, not exact).
    const override =
      claims.find((c) => c.source.startsWith('verified:')) ??
      claims.find((c) => c.source.startsWith('manual:'));
    if (override) return { winner: override, effective: override.value };
    return pickByStrategy(claims, 'HIGHEST_CONFIDENCE', now);
  }

  if (strategy === 'HIGHEST_CONFIDENCE') {
    // Rank by DECAYED confidence so the read path matches the writer (previously
    // this sorted on raw confidence — see open-questions/manual-edit-write-path.md).
    const w = [...claims].sort((a, b) => {
      const ea = computeEffectiveConfidence(a.confidence, a.ingested_at, now);
      const eb = computeEffectiveConfidence(b.confidence, b.ingested_at, now);
      if (eb !== ea) return eb - ea;
      return b.ingested_at.localeCompare(a.ingested_at);
    })[0];
    return { winner: w, effective: w.value };
  }

  if (strategy === 'LATEST_TIMESTAMP') {
    const w = [...claims].sort((a, b) => b.ingested_at.localeCompare(a.ingested_at))[0];
    return { winner: w, effective: w.value };
  }

  if (strategy === 'AUTHORITATIVE_ORDER') {
    // Ordering from the shared SOURCE_PRIORITY_ORDER registry (via sourceRank),
    // so the read path and the writer never disagree on source priority.
    const ranked = [...claims].sort((a, b) => sourceRank(a.source) - sourceRank(b.source));
    return { winner: ranked[0], effective: ranked[0].value };
  }

  if (strategy === 'MERGE_SET') {
    // All distinct values combined into a set. There's no single "winner" — pick
    // the highest-confidence claim as a representative for UI display.
    const merged = new Set<unknown>();
    for (const c of claims) {
      if (Array.isArray(c.value)) for (const v of c.value) merged.add(v);
      else merged.add(c.value);
    }
    const w = [...claims].sort((a, b) => b.confidence - a.confidence)[0];
    return { winner: w, effective: Array.from(merged) };
  }

  // Unknown strategy — fall back to highest confidence.
  return pickByStrategy(claims, 'HIGHEST_CONFIDENCE', now);
}

/**
 * A verified field needs re-review when a non-verified claim asserts a DIFFERENT
 * value and arrived after the verification — reality has drifted from the human's
 * assertion. The verified value still shows; we surface the drift for adjudication.
 */
function computeNeedsReview(group: PropertyClaim[], winner: PropertyClaim): boolean {
  const verified = group.find((c) => sourceKey(c.source) === 'verified');
  if (!verified) return false;
  const verifiedValue = verified.verified_value ?? verified.value;
  const verifiedAt = verified.verified_at ?? verified.ingested_at;
  return group.some(
    (c) =>
      sourceKey(c.source) !== 'verified' &&
      JSON.stringify(c.value) !== JSON.stringify(verifiedValue) &&
      c.ingested_at > verifiedAt,
  );
}

function parseClaims(raw: unknown): PropertyClaim[] {
  if (Array.isArray(raw)) return raw as PropertyClaim[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as PropertyClaim[];
    } catch {
      // ignore corrupted JSON — surfaces as "no claims"
    }
  }
  return [];
}

function hasConflict(claims: PropertyClaim[]): boolean {
  if (claims.length < 2) return false;
  const first = JSON.stringify(claims[0].value);
  for (let i = 1; i < claims.length; i++) {
    if (JSON.stringify(claims[i].value) !== first) return true;
  }
  return false;
}

function strategyFor(schema: ShipItSchema | null, label: string, key: string): ResolutionStrategy {
  const typeDef = schema?.node_types[label];
  const propDef = typeDef?.properties[key];
  if (propDef?.resolution_strategy) return propDef.resolution_strategy;
  return schema?.resolution_defaults?.[key] ?? 'HIGHEST_CONFIDENCE';
}

export class ClaimService {
  constructor(
    private neo4j: Neo4jService,
    private schemaService: SchemaService,
  ) {}

  async getClaimsForEntity(entityId: string): Promise<EntityClaims | null> {
    const records = await this.neo4j.runQuery(
      'MATCH (n {id: $id}) RETURN n, labels(n) AS labels LIMIT 1',
      { id: entityId },
    );
    if (records.length === 0) return null;

    const node = records[0].get('n') as { properties: Record<string, unknown> };
    const labels = records[0].get('labels') as string[];
    const label = labels[0] ?? 'Unknown';
    const claims = parseClaims(node.properties._claims);
    const schema = this.schemaService.getSchema();

    const grouped = new Map<string, PropertyClaim[]>();
    for (const c of claims) {
      const existing = grouped.get(c.property_key) ?? [];
      existing.push(c);
      grouped.set(c.property_key, existing);
    }

    const now = new Date();
    const tuning = DEFAULT_CONFIDENCE_TUNING;
    const properties: ResolvedProperty[] = [];
    for (const [key, group] of grouped) {
      const strategy = strategyFor(schema, label, key);
      const { winner, effective } = pickByStrategy(group, strategy, now);
      const conflict = hasConflict(group);

      if (!winner) {
        // No claims to score — emit a degenerate-but-typed row.
        properties.push({
          property_key: key,
          effective_value: effective,
          winning_claim: null,
          strategy,
          has_conflict: conflict,
          claims: group,
          confidence: 0,
          breakdown: {
            base: 0,
            base_source: 'none',
            decay: 0,
            corroboration: 0,
            corroboration_sources: [],
            conflict: 0,
            conflict_sources: [],
            ambiguity: 0,
            verified: false,
            verified_by: null,
            effective: 0,
            terms: [],
          },
          status: 'UNVERIFIED',
          needs_review: false,
        });
        continue;
      }

      const breakdown = computeFieldConfidence(group, winner, { now, tuning });
      const needsReview = computeNeedsReview(group, winner);
      const isStale =
        !breakdown.verified && weeksSince(winner.ingested_at, now) > tuning.staleWeeks;
      const status = deriveVerificationStatus({
        breakdown,
        hasConflict: conflict,
        isStale,
        needsReview,
      });

      properties.push({
        property_key: key,
        effective_value: effective,
        winning_claim: winner,
        strategy,
        has_conflict: conflict,
        claims: group,
        confidence: breakdown.effective,
        breakdown,
        status,
        needs_review: needsReview,
      });
    }

    properties.sort(
      (a, b) =>
        Number(b.has_conflict) - Number(a.has_conflict) ||
        a.property_key.localeCompare(b.property_key),
    );

    return {
      entityId,
      label,
      name: String(node.properties.name ?? entityId.split('/').pop() ?? entityId),
      properties,
    };
  }

  async listConflicts(opts: {
    label?: string;
    tier?: number;
    limit?: number;
  }): Promise<ConflictRow[]> {
    const { label, tier, limit = 100 } = opts;
    // We can't JSON-parse claims inside Cypher, so we read candidate nodes back
    // and detect conflicts in-app. Cap the scan to a reasonable batch.
    const scanLimit = Math.max(limit * 4, 200);
    const labelClause = label ? `:${label}` : '';
    const params: Record<string, unknown> = { scanLimit };
    let where = 'WHERE n._claims IS NOT NULL';
    if (tier !== undefined) {
      where += ' AND (n.tier_effective = $tier OR n.tier = $tier)';
      params.tier = tier;
    }
    const records = await this.neo4j.runQuery(
      `MATCH (n${labelClause}) ${where}
       RETURN n, labels(n) AS labels LIMIT toInteger($scanLimit)`,
      params,
    );

    const conflicts: ConflictRow[] = [];
    for (const record of records) {
      const node = record.get('n') as { properties: Record<string, unknown> };
      const labels = record.get('labels') as string[];
      const nodeLabel = labels[0] ?? 'Unknown';
      const claims = parseClaims(node.properties._claims);
      if (claims.length < 2) continue;

      const byKey = new Map<string, PropertyClaim[]>();
      for (const c of claims) {
        const arr = byKey.get(c.property_key) ?? [];
        arr.push(c);
        byKey.set(c.property_key, arr);
      }
      for (const [key, group] of byKey) {
        if (!hasConflict(group)) continue;
        const sources = Array.from(new Set(group.map((c) => c.source)));
        const values = Array.from(new Set(group.map((c) => JSON.stringify(c.value)))).map((v) =>
          JSON.parse(v),
        );
        const rawTier = node.properties.tier_effective ?? node.properties.tier;
        conflicts.push({
          entityId: String(node.properties.id),
          name: String(node.properties.name ?? node.properties.id),
          label: nodeLabel,
          tier: typeof rawTier === 'number' ? rawTier : rawTier == null ? null : Number(rawTier),
          propertyKey: key,
          sources,
          values,
          claimCount: group.length,
        });
      }
    }

    // Tier-1 conflicts first, then by entity name.
    conflicts.sort((a, b) => {
      const at = a.tier ?? 99;
      const bt = b.tier ?? 99;
      if (at !== bt) return at - bt;
      return a.name.localeCompare(b.name);
    });

    return conflicts.slice(0, limit);
  }
}
