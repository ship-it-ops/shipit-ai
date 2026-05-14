// Phase 2: Claim Explorer backend.
// Reads PropertyClaim[] JSON stored on each node's `_claims` property, groups
// by property_key, and applies the entity-type's resolution_strategy to pick
// the winning claim. Surfaces conflicts (>= 2 distinct values) for the
// dashboard view.
import type { PropertyClaim, ResolutionStrategy, ShipItSchema } from '@shipit-ai/shared';
import type { ConflictRow, EntityClaims, ResolvedProperty } from '@shipit-ai/shared';
import type { Neo4jService } from './neo4j-service.js';
import type { SchemaService } from './schema-service.js';

// Used by AUTHORITATIVE_ORDER when the schema doesn't carry a per-property
// override list. Mirrors the order suggested in design doc §5 and matches the
// seed-demo's source attribution.
const DEFAULT_SOURCE_ORDER = ['backstage', 'kubernetes', 'github', 'datadog', 'jira', 'manual'];

function pickByStrategy(
  claims: PropertyClaim[],
  strategy: ResolutionStrategy,
): { winner: PropertyClaim | null; effective: unknown } {
  if (claims.length === 0) return { winner: null, effective: null };

  if (strategy === 'MANUAL_OVERRIDE_FIRST') {
    const manual = claims.find((c) => c.source === 'manual');
    if (manual) return { winner: manual, effective: manual.value };
    return pickByStrategy(claims, 'HIGHEST_CONFIDENCE');
  }

  if (strategy === 'HIGHEST_CONFIDENCE') {
    const w = [...claims].sort((a, b) => b.confidence - a.confidence)[0];
    return { winner: w, effective: w.value };
  }

  if (strategy === 'LATEST_TIMESTAMP') {
    const w = [...claims].sort((a, b) => b.ingested_at.localeCompare(a.ingested_at))[0];
    return { winner: w, effective: w.value };
  }

  if (strategy === 'AUTHORITATIVE_ORDER') {
    const ranked = [...claims].sort((a, b) => {
      const ai = DEFAULT_SOURCE_ORDER.indexOf(a.source);
      const bi = DEFAULT_SOURCE_ORDER.indexOf(b.source);
      const aRank = ai === -1 ? Number.MAX_SAFE_INTEGER : ai;
      const bRank = bi === -1 ? Number.MAX_SAFE_INTEGER : bi;
      return aRank - bRank;
    });
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
  return pickByStrategy(claims, 'HIGHEST_CONFIDENCE');
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

    const properties: ResolvedProperty[] = [];
    for (const [key, group] of grouped) {
      const strategy = strategyFor(schema, label, key);
      const { winner, effective } = pickByStrategy(group, strategy);
      properties.push({
        property_key: key,
        effective_value: effective,
        winning_claim: winner,
        strategy,
        has_conflict: hasConflict(group),
        claims: group,
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
