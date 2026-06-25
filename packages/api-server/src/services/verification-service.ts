// Per-field verification: the first claim WRITE path (claims were seed-only before).
//
// A verification is a `verified:<user>` PropertyClaim appended to the node's
// `_claims` array — it rides the existing (source, source_id, property_key) dedup,
// so it survives connector re-syncs and pins the value. Each action also writes a
// VerificationEvent audit node, mirroring the reconciliation MergeEvent pattern
// (see reconciliation-service.ts). When a later sync contradicts a verified value
// the field surfaces in the review queue rather than being silently overwritten.
import { randomUUID } from 'node:crypto';
import type { ManagedTransaction } from 'neo4j-driver';
import type { PropertyClaim } from '@shipit-ai/shared';
import { getSourceReliability, sourceKey, pickManualOverride } from '@shipit-ai/shared';
import type { Neo4jService } from './neo4j-service.js';
import { loadClaimsLocked, writeClaims, parseClaims } from './claim-write-helpers.js';

const VERIFIED_RELIABILITY = getSourceReliability('verified').reliability;

/**
 * A human-attestation claim is one whose source registry-key is `verified` or
 * `manual` (both are namespaced as `verified:<actor>` / `manual:<actor>`). We
 * match on the COLON-DELIMITED registry key via `sourceKey`, never a loose
 * `STARTS WITH 'verified'` — that would miscategorize a connector source like
 * `verified_import` / `manualish` as a human override.
 */
function isOverrideClaim(claim: PropertyClaim): boolean {
  const key = sourceKey(claim.source);
  return key === 'verified' || key === 'manual';
}

/**
 * Stable dedup key for a contradicted GraphEditEvent. JSON.stringify of the
 * tuple so the segments stay delimited — a bare concatenation
 * (`${entityId}${propertyKey}${newValue}`) collides on boundary shifts
 * (e.g. ('ab','c',…) vs ('a','bc',…)) and could suppress a real `contradicted`
 * event. Both the read-existing and write sides MUST use this to agree.
 */
function contradictionKey(entityId: string, propertyKey: string, newValue: string): string {
  return JSON.stringify([entityId, propertyKey, newValue]);
}

export interface ReviewQueueRow {
  entityId: string;
  name: string;
  label: string;
  propertyKey: string;
  /**
   * Effective value of the human override (verified OR manual) that a fresher
   * connector claim now contradicts. Named `verifiedValue` for client back-compat;
   * `overrideSource` distinguishes the two.
   */
  verifiedValue: unknown;
  verifiedBy: string | null;
  /** Registry key of the human override: `verified` or `manual`. */
  overrideSource: 'verified' | 'manual';
  proposedValue: unknown;
  proposedSource: string;
}

export class VerificationService {
  constructor(private neo4j: Neo4jService) {}

  // Locked read-modify-write of `_claims` is shared with ManualEditService via
  // ./claim-write-helpers (loadClaimsLocked / writeClaims), so the `_claims_rev`
  // lock contract lives in one place.

  private async recordEvent(
    tx: ManagedTransaction,
    entityId: string,
    propertyKey: string,
    kind: string,
    actor: string,
    value: unknown,
    priorValue?: unknown,
  ): Promise<void> {
    await tx.run(
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
    return this.neo4j.runInWriteTransaction(async (tx) => {
      // Load (locked) → mutate → write → audit, all in one transaction so a
      // concurrent verify or connector re-sync can't clobber the assured value.
      const loaded = await loadClaimsLocked(tx, entityId);
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

      // Replace any prior verification of this exact field (one verified claim
      // per (verified, source_id, property_key)); leave connector claims intact.
      const next = loaded.claims.filter(
        (c) =>
          !(
            sourceKey(c.source) === 'verified' &&
            c.source_id === sourceId &&
            c.property_key === propertyKey
          ),
      );
      next.push(claim);
      await writeClaims(tx, entityId, next);
      await this.recordEvent(tx, entityId, propertyKey, 'verified', actor, value);
      return { ok: true };
    });
  }

  /**
   * Human overrides (verified OR manual) contradicted by a newer connector
   * claim, awaiting adjudication.
   *
   * Also EMITS a `contradicted` GraphEditEvent (deduped) per surfaced divergence
   * — see {@link emitContradictions}. The divergence-detection hook lives HERE,
   * in the review-queue computation, NOT on the hot write path: this method
   * already owns the override-vs-connector contradiction predicate, and the
   * connector resync that produces the divergence runs through core-writer
   * (off-limits / no edit hook). Detecting at scan time keeps that contract
   * intact while still giving operators an audit trail distinguishing a
   * deliberate override from stale drift.
   */
  async listReviewQueue(limit = 100): Promise<ReviewQueueRow[]> {
    // Push the "has a human-override field contradicted by a newer
    // non-override claim" predicate into Cypher (apoc parses the `_claims`
    // JSON), so the LIMIT bounds *candidate* nodes — ordered deterministically —
    // rather than a fixed prefix of all claim-bearing nodes in arbitrary order.
    // Otherwise a real candidate could fall outside the scan window and never
    // surface. The app-side loop below remains the authoritative row builder.
    //
    // Override match is colon-exact: split the source on ':' and compare the key
    // to 'verified'/'manual', so 'verified_import'/'manualish' can't masquerade
    // as a human override (the old `STARTS WITH 'verified'` did).
    const records = await this.neo4j.runQuery(
      `MATCH (n) WHERE n._claims IS NOT NULL AND n._claims STARTS WITH '['
       WITH n, apoc.convert.fromJsonList(n._claims) AS claims
       WHERE any(vc IN claims WHERE split(vc.source, ':')[0] IN ['verified','manual'] AND
         any(c IN claims WHERE
           NOT split(c.source, ':')[0] IN ['verified','manual']
           AND c.property_key = vc.property_key
           AND apoc.convert.toJson(c.value) <> apoc.convert.toJson(coalesce(vc.verified_value, vc.value))
           AND c.ingested_at > coalesce(vc.verified_at, vc.ingested_at)))
       RETURN n, labels(n) AS labels
       ORDER BY n.id
       LIMIT toInteger($scanLimit)`,
      { scanLimit: limit },
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
        // Use the SHARED deterministic resolver so the surfaced override is the
        // SAME claim the read-path resolves as effective (verified-outranks-manual,
        // then freshest ingested_at, then source). Array-order `find` could pick a
        // different equal-rank manual claim → 'accept' would re-pin a non-effective value.
        const override = pickManualOverride(group);
        if (!override) continue;
        const overrideValue = override.verified_value ?? override.value;
        const overrideAt = override.verified_at ?? override.ingested_at;
        const contradicting = group
          .filter(
            (c) =>
              !isOverrideClaim(c) &&
              JSON.stringify(c.value) !== JSON.stringify(overrideValue) &&
              c.ingested_at > overrideAt,
          )
          .sort((a, b) => b.ingested_at.localeCompare(a.ingested_at))[0];
        if (!contradicting) continue;
        rows.push({
          entityId: String(node.properties.id),
          name: String(node.properties.name ?? node.properties.id),
          label: labels[0] ?? 'Unknown',
          propertyKey: key,
          verifiedValue: overrideValue,
          verifiedBy: override.verified_by ?? override.source.split(':')[1] ?? null,
          overrideSource: sourceKey(override.source) as 'verified' | 'manual',
          proposedValue: contradicting.value,
          proposedSource: contradicting.source,
        });
        if (rows.length >= limit) {
          await this.emitContradictions(rows);
          return rows;
        }
      }
    }
    await this.emitContradictions(rows);
    return rows;
  }

  /**
   * Emit a `contradicted` GraphEditEvent for each surfaced divergence, ONCE per
   * distinct (entity_id, property_key, new_value) — a stable contradiction that
   * keeps re-appearing across scans must not spam the audit log. Dedup is done
   * against existing `contradicted` events. Best-effort: an audit write that
   * fails must never break the read path that operators rely on, so failures are
   * swallowed (the row is still returned for review).
   */
  private async emitContradictions(rows: ReviewQueueRow[]): Promise<void> {
    if (rows.length === 0) return;
    try {
      const existing = await this.neo4j.runQuery(
        `MATCH (e:GraphEditEvent {kind: 'contradicted'})
         RETURN e.entity_id AS entityId, e.property_key AS propertyKey, e.new_value AS newValue`,
      );
      const seen = new Set<string>();
      for (const rec of existing) {
        seen.add(
          contradictionKey(
            String(rec.get('entityId')),
            String(rec.get('propertyKey')),
            String(rec.get('newValue')),
          ),
        );
      }
      for (const row of rows) {
        const newValue = JSON.stringify(row.proposedValue);
        const dedupKey = contradictionKey(row.entityId, row.propertyKey, newValue);
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        await this.neo4j.runQuery(
          `MATCH (n {id: $entityId})
           CREATE (e:GraphEditEvent {
             id: $id, kind: 'contradicted',
             actor: $actor, entity_id: $entityId, property_key: $propertyKey,
             prior_value: $priorValue, new_value: $newValue, ts: datetime()
           })
           CREATE (e)-[:EDITS]->(n)`,
          {
            // actor = the contradicting connector/source ('system' if unknown),
            // so an operator can tell who drifted the value.
            id: `ge:${randomUUID()}`,
            actor: row.proposedSource || 'system',
            entityId: row.entityId,
            propertyKey: row.propertyKey,
            priorValue: JSON.stringify(row.verifiedValue),
            newValue,
          },
        );
      }
    } catch {
      // Audit emission is best-effort; never fail the review-queue read.
    }
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
    return this.neo4j.runInWriteTransaction(async (tx) => {
      const loaded = await loadClaimsLocked(tx, entityId);
      if (!loaded) throw new Error(`Entity ${entityId} not found`);
      const group = loaded.claims.filter((c) => c.property_key === propertyKey);
      // Adjudicate the SAME override the read-path resolves as effective: the
      // shared deterministic resolver (verified outranks manual, then freshest,
      // then source). The review queue surfaces this exact claim.
      const override = pickManualOverride(group);
      if (!override) throw new Error(`No human override on ${entityId}#${propertyKey}`);
      const overrideSource = override.source;
      const overrideValue = override.verified_value ?? override.value;
      const overrideAt = override.verified_at ?? override.ingested_at;

      let newValue = overrideValue;
      if (action === 'accept') {
        const contradicting = group
          .filter(
            (c) =>
              !isOverrideClaim(c) &&
              JSON.stringify(c.value) !== JSON.stringify(overrideValue) &&
              c.ingested_at > overrideAt,
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

      // Re-pin the exact override claim that was adjudicated. We set
      // `verified_value`/`verified_at` even on a `manual:*` claim so the
      // (override fresher than contradiction) predicate stops firing for it too.
      const next = loaded.claims.map((c) =>
        c.source === overrideSource && c.property_key === propertyKey
          ? { ...c, value: newValue, verified_value: newValue, verified_at: now, ingested_at: now }
          : c,
      );
      await writeClaims(tx, entityId, next);
      await this.recordEvent(
        tx,
        entityId,
        propertyKey,
        action === 'accept' ? 'accepted' : 'rejected',
        actor,
        newValue,
        overrideValue,
      );
      return { ok: true };
    });
  }
}
