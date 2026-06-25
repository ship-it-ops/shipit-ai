// Manual-edit write path (v1a, claims): a user-authored `manual:<actor>`
// PropertyClaim overrides a node's resolved value and DURABLY survives connector
// re-syncs. A manual claim is just another claim type alongside `verified:` —
// `manual` already ranks 2nd (below `verified`) in the shared SOURCE_PRIORITY_ORDER,
// so it wins the MANUAL_OVERRIDE_FIRST strategy without registry changes.
//
// Each mutation is a locked read-modify-write on the node's `_claims` array via the
// SHARED `_claims_rev` lock helpers (claim-write-helpers.ts) — the same lock
// authority core-writer's mergeNode compare-and-sets (T0), so a concurrent connector
// resync can't clobber a manual claim written between its read and write.
//
// Audit: every mutation writes a GraphEditEvent node in the SAME transaction (atomic
// — an audit failure rolls back the edit). prior_value is the property's effective
// value computed via the EXACT read-path resolution, captured inside the tx before
// the mutation.
//
// FUTURE UNIFICATION: VerificationEvent (verification-service.ts) and GraphEditEvent
// are parallel audit-node shapes. A later task should unify them under one labeled
// node with a `kind` discriminator; GraphEditEvent already carries `kind`
// (manual_set / manual_revert today; relation kinds + `contradicted` arrive in
// T3 / T-sync). Left separate here to keep VerificationService behavior unchanged.
import { randomUUID } from 'node:crypto';
import type { ManagedTransaction } from 'neo4j-driver';
import type { PropertyClaim, ResolvedProperty } from '@shipit-ai/shared';
import { getSourceReliability } from '@shipit-ai/shared';
import type { Neo4jService } from './neo4j-service.js';
import type { ClaimService } from './claim-service.js';
import { pickByStrategy, strategyFor } from './claim-service.js';
import type { SchemaService } from './schema-service.js';
import { loadClaimsLocked, writeClaims } from './claim-write-helpers.js';

const MANUAL_RELIABILITY = getSourceReliability('manual').reliability;

/**
 * A graph-edit audit event kind.
 * - `manual_set` / `manual_revert`: a human property override or its removal.
 * - `contradicted`: a connector re-sync produced a value that diverges from an
 *   existing human override (manual/verified). Emitted by the review-queue
 *   computation (VerificationService) so operators can tell a deliberate
 *   override from stale connector drift. Relation kinds arrive in T3.
 */
export type GraphEditKind = 'manual_set' | 'manual_revert' | 'contradicted';

/** Input rejected before any write (route maps to 400). */
export class ManualEditValidationError extends Error {
  readonly code: 'INVALID_VALUE_TYPE';
  constructor(message: string, code: 'INVALID_VALUE_TYPE' = 'INVALID_VALUE_TYPE') {
    super(message);
    this.name = 'ManualEditValidationError';
    this.code = code;
  }
}

/**
 * Target not found. `ENTITY_NOT_FOUND` (node missing) → route maps to 404;
 * `NO_MANUAL_CLAIM` (revert had nothing to remove) → route maps to idempotent 204.
 */
export class ManualEditNotFoundError extends Error {
  readonly code: 'ENTITY_NOT_FOUND' | 'NO_MANUAL_CLAIM';
  constructor(message: string, code: 'ENTITY_NOT_FOUND' | 'NO_MANUAL_CLAIM') {
    super(message);
    this.name = 'ManualEditNotFoundError';
    this.code = code;
  }
}

export interface SetManualClaimInput {
  entityId: string;
  propertyKey: string;
  value: unknown;
  evidence?: string | null;
  actor: string;
}

export interface RevertManualClaimInput {
  entityId: string;
  propertyKey: string;
  actor: string;
  /** Admin use: revert this actor's manual claim instead of the caller's own. */
  targetActor?: string;
}

/** What both write methods return so a route can echo the new state to the client. */
export interface ManualEditResult {
  property: ResolvedProperty;
  claimsRev: number;
}

export class ManualEditService {
  constructor(
    private neo4j: Neo4jService,
    private claimService: ClaimService,
    private schemaService: SchemaService,
  ) {}

  /**
   * Override a property with a `manual:<actor>` claim (one per property per actor —
   * replaces the actor's prior manual claim on this property). Locked RMW + atomic
   * audit. v1 is string-only; a non-string value is rejected before any write.
   */
  async setManualClaim(input: SetManualClaimInput): Promise<ManualEditResult> {
    const { entityId, propertyKey, value, actor } = input;
    const evidence = input.evidence ?? null;

    // String-only (v1). Reject up front so T4a can map to 400 without a partial write.
    if (typeof value !== 'string') {
      throw new ManualEditValidationError(
        `Manual claim value must be a string (got ${typeof value})`,
      );
    }

    // evidence is `string | null`. A client could send an object/array, which
    // would otherwise be JSON-serialized into the stored PropertyClaim, violating
    // the contract. Reject any non-null, non-string before any write.
    if (evidence !== null && typeof evidence !== 'string') {
      throw new ManualEditValidationError(
        `Manual claim evidence must be a string or null (got ${typeof evidence})`,
      );
    }

    return this.neo4j.runInWriteTransaction(async (tx) => {
      const loaded = await loadClaimsLocked(tx, entityId);
      if (!loaded) {
        throw new ManualEditNotFoundError(`Entity ${entityId} not found`, 'ENTITY_NOT_FOUND');
      }

      const priorValue = this.resolveEffective(loaded.claims, loaded.label, propertyKey);
      const now = new Date().toISOString();
      const source = `manual:${actor}`;

      const claim: PropertyClaim = {
        property_key: propertyKey,
        value,
        source,
        source_id: `manual://${entityId}#${propertyKey}`,
        ingested_at: now,
        confidence: MANUAL_RELIABILITY,
        evidence,
      };

      // One manual claim per (this actor, this property): replace if present.
      const next = loaded.claims.filter(
        (c) => !(c.source === source && c.property_key === propertyKey),
      );
      next.push(claim);

      await writeClaims(tx, entityId, next);
      await this.recordEvent(tx, {
        kind: 'manual_set',
        actor,
        entityId,
        propertyKey,
        priorValue,
        newValue: value,
      });

      return this.buildResult(tx, entityId, next, loaded.label, propertyKey);
    });
  }

  /**
   * Remove a manual claim and fall back to the next-ranked claim. By default
   * removes the caller's own `manual:<actor>`; `targetActor` (admin) removes that
   * actor's instead. No matching manual claim → ManualEditNotFoundError(NO_MANUAL_CLAIM)
   * so the route can answer idempotent 204.
   */
  async revertManualClaim(input: RevertManualClaimInput): Promise<ManualEditResult> {
    const { entityId, propertyKey, actor } = input;
    const removedActor = input.targetActor ?? actor;
    const removedSource = `manual:${removedActor}`;

    return this.neo4j.runInWriteTransaction(async (tx) => {
      const loaded = await loadClaimsLocked(tx, entityId);
      if (!loaded) {
        throw new ManualEditNotFoundError(`Entity ${entityId} not found`, 'ENTITY_NOT_FOUND');
      }

      const removed = loaded.claims.find(
        (c) => c.source === removedSource && c.property_key === propertyKey,
      );
      if (!removed) {
        throw new ManualEditNotFoundError(
          `No ${removedSource} claim on ${entityId}#${propertyKey}`,
          'NO_MANUAL_CLAIM',
        );
      }

      const priorValue = this.resolveEffective(loaded.claims, loaded.label, propertyKey);
      const next = loaded.claims.filter(
        (c) => !(c.source === removedSource && c.property_key === propertyKey),
      );
      const newValue = this.resolveEffective(next, loaded.label, propertyKey);

      await writeClaims(tx, entityId, next);
      await this.recordEvent(tx, {
        kind: 'manual_revert',
        actor,
        entityId,
        propertyKey,
        priorValue,
        newValue,
      });

      return this.buildResult(tx, entityId, next, loaded.label, propertyKey);
    });
  }

  /** Effective value of a property via the EXACT read-path resolution strategy. */
  private resolveEffective(claims: PropertyClaim[], label: string, propertyKey: string): unknown {
    const group = claims.filter((c) => c.property_key === propertyKey);
    const strategy = strategyFor(this.schemaService.getSchema(), label, propertyKey);
    return pickByStrategy(group, strategy, new Date()).effective;
  }

  /**
   * Re-read the resolved property for the route to return. Reads `_claims_rev`
   * back from the SAME node inside this tx (it was bumped by loadClaimsLocked) so
   * the client can detect lost updates on its next write.
   */
  private async buildResult(
    tx: ManagedTransaction,
    entityId: string,
    claims: PropertyClaim[],
    label: string,
    propertyKey: string,
  ): Promise<ManualEditResult> {
    const property = this.claimService.resolveProperty(claims, label, propertyKey);
    const res = await tx.run('MATCH (n {id: $id}) RETURN n._claims_rev AS rev LIMIT 1', {
      id: entityId,
    });
    const raw = res.records[0]?.get('rev');
    return { property, claimsRev: toInt(raw) };
  }

  private async recordEvent(
    tx: ManagedTransaction,
    e: {
      kind: GraphEditKind;
      actor: string;
      entityId: string;
      propertyKey: string;
      priorValue: unknown;
      newValue: unknown;
    },
  ): Promise<void> {
    // Same tx as the claim write → atomic. Mirrors VerificationEvent's
    // `(e)-[:EDITS]->(n)` style with an EDITS relationship.
    await tx.run(
      `MATCH (n {id: $entityId})
       CREATE (e:GraphEditEvent {
         id: $id, kind: $kind, actor: $actor, entity_id: $entityId,
         property_key: $propertyKey, prior_value: $priorValue, new_value: $newValue,
         ts: datetime()
       })
       CREATE (e)-[:EDITS]->(n)`,
      {
        id: `ge:${randomUUID()}`,
        kind: e.kind,
        actor: e.actor,
        entityId: e.entityId,
        propertyKey: e.propertyKey,
        priorValue: e.priorValue === undefined ? null : JSON.stringify(e.priorValue),
        newValue: e.newValue === undefined ? null : JSON.stringify(e.newValue),
      },
    );
  }
}

/** Neo4j integers arrive as { low, high }; tolerate plain numbers (fakes/tests). */
function toInt(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (raw && typeof raw === 'object' && 'low' in raw) return Number((raw as { low: number }).low);
  return Number(raw) || 0;
}
