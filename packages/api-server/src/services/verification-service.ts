// Per-field verification: the first claim WRITE path (claims were seed-only before).
//
// A verification is a `verified:<user>` PropertyClaim appended to the node's
// `_claims` array — it rides the existing (source, source_id, property_key) dedup,
// so it survives connector re-syncs and pins the value. Each action also writes a
// VerificationEvent audit node, mirroring the reconciliation MergeEvent pattern
// (see reconciliation-service.ts). When a later sync contradicts a verified value
// the field surfaces in the review queue rather than being silently overwritten.
import { randomUUID } from 'node:crypto';
import type { PropertyClaim } from '@shipit-ai/shared';
import { getSourceReliability, sourceKey } from '@shipit-ai/shared';
import type { Neo4jService } from './neo4j-service.js';

const VERIFIED_RELIABILITY = getSourceReliability('verified').reliability;

export interface ReviewQueueRow {
  entityId: string;
  name: string;
  label: string;
  propertyKey: string;
  verifiedValue: unknown;
  verifiedBy: string | null;
  proposedValue: unknown;
  proposedSource: string;
}

function parseClaims(raw: unknown): PropertyClaim[] {
  if (Array.isArray(raw)) return raw as PropertyClaim[];
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as PropertyClaim[];
    } catch {
      // corrupted JSON — treat as no claims
    }
  }
  return [];
}

export class VerificationService {
  constructor(private neo4j: Neo4jService) {}

  private async loadClaims(entityId: string): Promise<{
    claims: PropertyClaim[];
    name: string;
    label: string;
  } | null> {
    const records = await this.neo4j.runQuery(
      'MATCH (n {id: $id}) RETURN n, labels(n) AS labels LIMIT 1',
      { id: entityId },
    );
    if (records.length === 0) return null;
    const node = records[0].get('n') as { properties: Record<string, unknown> };
    const labels = records[0].get('labels') as string[];
    return {
      claims: parseClaims(node.properties._claims),
      name: String(node.properties.name ?? entityId.split('/').pop() ?? entityId),
      label: labels[0] ?? 'Unknown',
    };
  }

  private async writeClaims(entityId: string, claims: PropertyClaim[]): Promise<void> {
    await this.neo4j.runQuery('MATCH (n {id: $id}) SET n._claims = $claims', {
      id: entityId,
      claims: JSON.stringify(claims),
    });
  }

  private async recordEvent(
    entityId: string,
    propertyKey: string,
    kind: string,
    actor: string,
    value: unknown,
    priorValue?: unknown,
  ): Promise<void> {
    await this.neo4j.runQuery(
      `MATCH (n {id: $entityId})
       CREATE (v:VerificationEvent {
         id: $id, entityId: $entityId, property_key: $propertyKey,
         kind: $kind, actor: $actor, timestamp: datetime(),
         value: $value, prior_value: $priorValue
       })
       CREATE (v)-[:VERIFIES]->(n)`,
      {
        id: `ve:${randomUUID()}`,
        entityId,
        propertyKey,
        kind,
        actor,
        value: JSON.stringify(value),
        priorValue: priorValue === undefined ? null : JSON.stringify(priorValue),
      },
    );
  }

  /** Verify a field: append/replace the `verified:<actor>` claim and audit it. */
  async verify(
    entityId: string,
    propertyKey: string,
    value: unknown,
    actor: string,
    evidence: string | null = null,
  ): Promise<{ ok: true }> {
    const loaded = await this.loadClaims(entityId);
    if (!loaded) throw new Error(`Entity ${entityId} not found`);
    const now = new Date().toISOString();
    const source = `verified:${actor}`;
    const sourceId = `verified://${entityId}#${propertyKey}`;

    const claim: PropertyClaim = {
      property_key: propertyKey,
      value,
      source,
      source_id: sourceId,
      ingested_at: now,
      confidence: VERIFIED_RELIABILITY,
      evidence,
      verified_by: actor,
      verified_at: now,
      verified_value: value,
    };

    // Replace any prior verification of this exact field (one verified claim per
    // (verified, source_id, property_key)); leave connector claims intact.
    const next = loaded.claims.filter(
      (c) =>
        !(
          sourceKey(c.source) === 'verified' &&
          c.source_id === sourceId &&
          c.property_key === propertyKey
        ),
    );
    next.push(claim);
    await this.writeClaims(entityId, next);
    await this.recordEvent(entityId, propertyKey, 'verified', actor, value);
    return { ok: true };
  }

  /** Verified fields contradicted by a newer connector claim, awaiting adjudication. */
  async listReviewQueue(limit = 100): Promise<ReviewQueueRow[]> {
    const records = await this.neo4j.runQuery(
      `MATCH (n) WHERE n._claims IS NOT NULL
       RETURN n, labels(n) AS labels LIMIT toInteger($scanLimit)`,
      { scanLimit: Math.max(limit * 4, 200) },
    );
    const rows: ReviewQueueRow[] = [];
    for (const rec of records) {
      const node = rec.get('n') as { properties: Record<string, unknown> };
      const labels = rec.get('labels') as string[];
      const claims = parseClaims(node.properties._claims);
      const byKey = new Map<string, PropertyClaim[]>();
      for (const c of claims) {
        const arr = byKey.get(c.property_key) ?? [];
        arr.push(c);
        byKey.set(c.property_key, arr);
      }
      for (const [key, group] of byKey) {
        const verified = group.find((c) => sourceKey(c.source) === 'verified');
        if (!verified) continue;
        const verifiedValue = verified.verified_value ?? verified.value;
        const verifiedAt = verified.verified_at ?? verified.ingested_at;
        const contradicting = group
          .filter(
            (c) =>
              sourceKey(c.source) !== 'verified' &&
              JSON.stringify(c.value) !== JSON.stringify(verifiedValue) &&
              c.ingested_at > verifiedAt,
          )
          .sort((a, b) => b.ingested_at.localeCompare(a.ingested_at))[0];
        if (!contradicting) continue;
        rows.push({
          entityId: String(node.properties.id),
          name: String(node.properties.name ?? node.properties.id),
          label: labels[0] ?? 'Unknown',
          propertyKey: key,
          verifiedValue,
          verifiedBy: verified.verified_by ?? null,
          proposedValue: contradicting.value,
          proposedSource: contradicting.source,
        });
        if (rows.length >= limit) return rows;
      }
    }
    return rows;
  }

  /**
   * Resolve a queued re-review.
   * - `accept`: the verified value becomes the newest contradicting value.
   * - `reject`: re-pin the existing verified value (bump verified_at past the
   *   contradicting claim so it stops re-firing).
   */
  async resolveReview(
    entityId: string,
    propertyKey: string,
    action: 'accept' | 'reject',
    actor: string,
  ): Promise<{ ok: true }> {
    const loaded = await this.loadClaims(entityId);
    if (!loaded) throw new Error(`Entity ${entityId} not found`);
    const group = loaded.claims.filter((c) => c.property_key === propertyKey);
    const verified = group.find((c) => sourceKey(c.source) === 'verified');
    if (!verified) throw new Error(`No verified claim on ${entityId}#${propertyKey}`);
    const verifiedValue = verified.verified_value ?? verified.value;
    const verifiedAt = verified.verified_at ?? verified.ingested_at;

    let newValue = verifiedValue;
    if (action === 'accept') {
      const contradicting = group
        .filter(
          (c) =>
            sourceKey(c.source) !== 'verified' &&
            JSON.stringify(c.value) !== JSON.stringify(verifiedValue) &&
            c.ingested_at > verifiedAt,
        )
        .sort((a, b) => b.ingested_at.localeCompare(a.ingested_at))[0];
      if (contradicting) newValue = contradicting.value;
    }

    // Re-pin newer than every current claim so the decision supersedes the
    // contradicting sync and the field stops re-firing into the review queue.
    const newestClaimMs = Math.max(
      0,
      ...loaded.claims.map((c) => Date.parse(c.ingested_at)).filter((n) => Number.isFinite(n)),
    );
    const now = new Date(Math.max(Date.now(), newestClaimMs + 1000)).toISOString();

    const next = loaded.claims.map((c) =>
      sourceKey(c.source) === 'verified' && c.property_key === propertyKey
        ? { ...c, value: newValue, verified_value: newValue, verified_at: now, ingested_at: now }
        : c,
    );
    await this.writeClaims(entityId, next);
    await this.recordEvent(
      entityId,
      propertyKey,
      action === 'accept' ? 'accepted' : 'rejected',
      actor,
      newValue,
      verifiedValue,
    );
    return { ok: true };
  }
}
