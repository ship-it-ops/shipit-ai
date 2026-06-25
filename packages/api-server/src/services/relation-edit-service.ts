// Manual-edit write path (v1b, relations): a user-authored relationship edge,
// distinct from connector-ingested topology. A manual edge is stamped with a
// POSITIVE provenance marker (`_manual_actor`) so every later read/delete can
// tell it apart from connector edges by a property check — never by parsing the
// `_source` string. Connector edges (core-writer's mergeEdge) set `_source` and
// `_confidence`/`_ingested_at` but NEVER `_manual_actor`, so the two populations
// are cleanly separable.
//
// Why a dedicated Cypher (not core-writer's mergeEdge): mergeEdge does an
// unconditional `SET r += $properties` on MATCH, which would silently overwrite
// a connector edge's properties when a human re-asserts the same edge. The
// manual path instead leaves a pre-existing connector edge UNTOUCHED.
//
// Audit: every mutation writes a GraphEditEvent node in the SAME transaction
// (atomic — an audit failure rolls back the edit), mirroring ManualEditService.
import { randomUUID } from 'node:crypto';
import type { ManagedTransaction } from 'neo4j-driver';
import { getSourceReliability } from '@shipit-ai/shared';
import type { Neo4jService } from './neo4j-service.js';
import type { SchemaService } from './schema-service.js';

const MANUAL_RELIABILITY = getSourceReliability('manual').reliability;

/**
 * Sanitize a relationship type for safe interpolation into Cypher (the only
 * place a `:TYPE` is not bindable as a parameter). Mirrors core-writer's
 * `sanitizeLabel` (kept local — api-server does not depend on core-writer).
 * NOTE: this MANGLES rather than validates; it is applied ONLY AFTER the raw
 * value has passed the strict schema allow-list, so any value reaching here is
 * already a verbatim schema key (alphanumeric/underscore by construction). It
 * is defense-in-depth, never the primary gate.
 */
function sanitizeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * A Neo4j relationship property value must be a primitive (string/number/boolean)
 * or a homogeneous array of primitives — NEVER a nested object/map. Passing a
 * non-primitive into `SET r += $properties` makes the server throw
 * `Neo.ClientError.Statement.TypeError` mid-transaction, which the route maps to
 * a 500. Reject such values UP FRONT with a typed 400 instead, mirroring how the
 * connector ingest path sanitizes property values before a write.
 */
function isPrimitive(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

/**
 * Validate a client-supplied relationship `properties` map BEFORE it reaches the
 * Cypher `r += $properties`. Two distinct guards:
 *
 *  1. RESERVED-KEY guard (security — provenance/audit forgery): reject ANY key
 *     matching `/^_/`. `r += $properties` is the LAST clause of `ON CREATE SET`,
 *     so an `_`-prefixed key would override the server-stamped
 *     `_manual_actor`/`_source`/`_confidence`/`_ingested_at` AFTER they are set.
 *     A `graph:write` caller could thereby forge attribution, disguise a manual
 *     edge as a connector edge, corrupt the `justCreated` derivation (silent
 *     un-audited create), or null-out the `_manual_actor` marker. Forbidding
 *     `_`-prefixed keys closes all of those: the client can never touch any
 *     internal provenance property.
 *
 *  2. TYPE guard (correctness): a Neo4j relationship property value must be a
 *     primitive or a homogeneous array of NON-NULL primitives — never a nested
 *     object/map, and never an array containing a null element (a null list
 *     element makes Neo4j throw `Neo.ClientError.Statement.TypeError`
 *     mid-transaction → a 500). Reject such values up front with a typed 400.
 *
 * A top-level null value (`{weight: null}`) is accepted: `isPrimitive(null)` is
 * true. `r += {weight: null}` is a documented Neo4j no-op (it removes/ignores
 * the key), and since reserved keys are already forbidden a top-level null can
 * only target a client-owned property — harmless. We keep the simplest correct
 * behavior (accept, let Neo4j drop it) rather than adding a null-stripping pass.
 */
function assertValidProperties(properties: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(properties)) {
    if (key.startsWith('_')) {
      throw new RelationEditValidationError(
        `Property key "${key}" is reserved (underscore-prefixed keys are ` +
          `server-managed provenance and cannot be set by a client)`,
        'INVALID_PROPERTIES',
      );
    }
    if (isPrimitive(value)) continue;
    // Array branch: reject null elements (a null list element is NOT storable on
    // a relationship and throws a TypeError mid-transaction).
    if (Array.isArray(value) && value.every((v) => v !== null && isPrimitive(v))) continue;
    throw new RelationEditValidationError(
      `Property "${key}" must be a primitive or array of non-null primitives ` +
        `(nested objects/maps and null array elements are not allowed for ` +
        `relationship properties)`,
      'INVALID_PROPERTIES',
    );
  }
}

/** Input rejected before any write (route maps to 400). */
export class RelationEditValidationError extends Error {
  readonly code:
    | 'INVALID_RELATION_TYPE'
    | 'SELF_LOOP'
    | 'ENDPOINT_LABEL_MISMATCH'
    | 'INVALID_PROPERTIES';
  constructor(message: string, code: RelationEditValidationError['code']) {
    super(message);
    this.name = 'RelationEditValidationError';
    this.code = code;
  }
}

/** An endpoint node was not found (route maps to 404). */
export class RelationEditNotFoundError extends Error {
  readonly code: 'ENDPOINT_NOT_FOUND';
  constructor(message: string) {
    super(message);
    this.name = 'RelationEditNotFoundError';
    this.code = 'ENDPOINT_NOT_FOUND';
  }
}

/**
 * A state conflict that a manual edit must refuse rather than violate. Two
 * distinct causes, both 409:
 *   - `CONNECTOR_EDGE`: the target edge exists but is connector-owned
 *     (`_manual_actor IS NULL`), so a manual delete must not destroy connector
 *     topology.
 *   - `CARDINALITY_VIOLATION`: creating this edge would exceed the schema's
 *     declared cardinality for the type (e.g. a second OWNS owner on a 1:N
 *     to-node). A graph-model invariant — counted across connector + manual
 *     edges alike, since either population can already occupy the capped slot.
 */
export class RelationEditConflictError extends Error {
  readonly code: 'CONNECTOR_EDGE' | 'CARDINALITY_VIOLATION';
  constructor(message: string, code: RelationEditConflictError['code'] = 'CONNECTOR_EDGE') {
    super(message);
    this.name = 'RelationEditConflictError';
    this.code = code;
  }
}

export interface AddRelationInput {
  from: string;
  to: string;
  type: string;
  properties?: Record<string, unknown>;
  actor: string;
}

export interface DeleteRelationInput {
  from: string;
  to: string;
  type: string;
  actor: string;
}

export interface AddRelationResult {
  created: boolean;
  /** True when an existing CONNECTOR-owned edge of this type was left untouched. */
  preexistingConnectorEdge?: boolean;
}

export class RelationEditService {
  constructor(
    private neo4j: Neo4jService,
    private schemaService: SchemaService,
  ) {}

  /**
   * Author a manual relationship edge. Validates the raw `type` against the LIVE
   * schema with STRICT EQUALITY *before* any sanitizeLabel (so an injection-y raw
   * value that merely sanitizes to an allow-listed type is rejected), checks
   * from/to endpoint existence + label constraints, then MERGEs a `_manual_actor`
   * edge. A pre-existing connector edge of the same type is left UNTOUCHED.
   */
  async addRelation(input: AddRelationInput): Promise<AddRelationResult> {
    const { from, to, type, actor } = input;
    const properties = input.properties ?? {};

    // Validate the RAW type against the live schema BEFORE sanitizing — never
    // sanitize-then-accept. `relType` is the canonical schema key.
    const relDef = this.requireSchemaRelType(type);

    // Self-loop is meaningless for these relationship types and would create a
    // node-to-itself edge. Reject before any DB round-trip.
    if (from === to) {
      throw new RelationEditValidationError(
        `Self-loops are not allowed (from === to: ${from})`,
        'SELF_LOOP',
      );
    }

    // Reject reserved (`_`-prefixed) keys and non-storable values BEFORE the
    // write. The reserved-key guard is load-bearing for security: `r += $properties`
    // is the LAST `ON CREATE SET` clause, so without it a client could override the
    // server-stamped provenance (`_manual_actor`/`_source`/`_ingested_at`) — forging
    // attribution or corrupting the `justCreated` audit derivation.
    assertValidProperties(properties);

    // Only after the raw allow-list check passes do we interpolate the type into
    // Cypher. sanitizeLabel is belt-and-suspenders here: the value is already a
    // verbatim schema key, so it is alphanumeric/underscore by construction.
    const safeType = sanitizeLabel(type);
    const now = new Date().toISOString();
    const source = `manual:${actor}`;

    return this.neo4j.runInWriteTransaction(async (tx) => {
      // Endpoint existence + label constraints in one read so a missing node and
      // a constraint violation are distinguished with precise errors.
      const endpoints = await this.loadEndpoints(tx, from, to);
      if (!endpoints.fromExists) {
        throw new RelationEditNotFoundError(`From node ${from} not found`);
      }
      if (!endpoints.toExists) {
        throw new RelationEditNotFoundError(`To node ${to} not found`);
      }
      this.assertEndpointLabels(relDef, endpoints.fromLabels, endpoints.toLabels, type);

      // Enforce the schema's declared cardinality BEFORE the MERGE write. A
      // violation is a state conflict (409), not bad input. The (from,to) pair
      // itself is excluded so re-adding the EXACT same edge stays idempotent.
      await this.assertCardinality(tx, relDef, from, to, type, safeType);

      // MERGE the edge. ON CREATE stamps the manual provenance marker. ON MATCH
      // we MUST NOT touch a connector edge (its `_manual_actor IS NULL`) — so we
      // only set the marker for an edge that already had it (idempotent no-op on
      // a manual edge; literally a no-op on a connector edge). The RETURN reports
      // whether the edge was just created and whether the matched edge was a
      // pre-existing connector edge.
      const result = await tx.run(
        `MATCH (from {id: $from}), (to {id: $to})
         MERGE (from)-[r:${safeType}]->(to)
         ON CREATE SET r._source = $source,
                       r._manual_actor = $actor,
                       r._confidence = $confidence,
                       r._ingested_at = $now,
                       r += $properties
         RETURN r._manual_actor IS NOT NULL AS isManual,
                (r._ingested_at = $now AND r._manual_actor = $actor) AS justCreated`,
        { from, to, source, actor, confidence: MANUAL_RELIABILITY, now, properties },
      );

      const record = result.records[0];
      const isManual = record?.get('isManual') === true;
      const justCreated = record?.get('justCreated') === true;

      if (justCreated) {
        // The edge was created by this MERGE. Audit it.
        await this.recordEvent(tx, { kind: 'relation_added', actor, from, to, type });
        return { created: true };
      }

      // Edge already existed. If it is connector-owned, leave it untouched.
      if (!isManual) {
        return { created: false, preexistingConnectorEdge: true };
      }
      // Already a manual edge → idempotent no-op (no audit, nothing changed).
      return { created: false };
    });
  }

  /**
   * Delete a MANUAL relationship edge (positive provenance: `_manual_actor IS NOT
   * NULL`). A connector-owned edge of the same type is NEVER deleted — if one is
   * the only match, refuse with a conflict (409). No matching edge at all →
   * idempotent (the route answers 204). Hard delete; writes a `relation_removed`
   * GraphEditEvent.
   *
   * Returns true when a manual edge was deleted, false when nothing matched.
   */
  async deleteRelation(input: DeleteRelationInput): Promise<boolean> {
    const { from, to, type, actor } = input;

    // Validate raw type before interpolating (same allow-list as addRelation).
    this.requireSchemaRelType(type);
    const safeType = sanitizeLabel(type);

    return this.neo4j.runInWriteTransaction(async (tx) => {
      // Inspect every edge of this type between the endpoints. We never delete a
      // connector edge by string convention — only one whose `_manual_actor` is
      // set is eligible. Distinguish "manual edge deleted" / "only a connector
      // edge exists (409)" / "nothing here (204)".
      const probe = await tx.run(
        `MATCH (from {id: $from})-[r:${safeType}]->(to {id: $to})
         RETURN count(r) AS total,
                count(CASE WHEN r._manual_actor IS NOT NULL THEN 1 END) AS manual`,
        { from, to },
      );
      const probeRec = probe.records[0];
      const total = toInt(probeRec?.get('total'));
      const manual = toInt(probeRec?.get('manual'));

      if (manual === 0) {
        if (total > 0) {
          // A matching edge exists but it's connector-owned → refuse.
          throw new RelationEditConflictError(
            `Refusing to delete connector-owned ${type} edge ${from} -> ${to}`,
          );
        }
        // Nothing to delete → idempotent.
        return false;
      }

      // Hard-delete only the manual edge(s) — positive provenance marker.
      await tx.run(
        `MATCH (from {id: $from})-[r:${safeType}]->(to {id: $to})
         WHERE r._manual_actor IS NOT NULL
         DELETE r`,
        { from, to },
      );
      await this.recordEvent(tx, { kind: 'relation_removed', actor, from, to, type });
      return true;
    });
  }

  /**
   * Resolve the raw relation type against the LIVE schema with STRICT EQUALITY on
   * the raw value. Rejects a non-member (or a value that only sanitizes to a
   * member) with a typed 400. Returns the schema definition for endpoint checks.
   */
  private requireSchemaRelType(type: string) {
    const schema = this.schemaService.getSchema();
    const relTypes = schema?.relationship_types ?? {};
    // Strict membership on the RAW string. `Object.prototype.hasOwnProperty`
    // avoids prototype-chain keys (`toString`, etc.) being treated as valid.
    if (!Object.prototype.hasOwnProperty.call(relTypes, type)) {
      throw new RelationEditValidationError(
        `Unknown relationship type: ${type}`,
        'INVALID_RELATION_TYPE',
      );
    }
    return relTypes[type];
  }

  /**
   * Enforce the schema's from/to label constraints for this relation type when
   * declared. A node may carry multiple labels; the constraint is satisfied if
   * the required label is among them.
   */
  private assertEndpointLabels(
    relDef: { from?: string; to?: string },
    fromLabels: string[],
    toLabels: string[],
    type: string,
  ): void {
    if (relDef.from && !fromLabels.includes(relDef.from)) {
      throw new RelationEditValidationError(
        `${type} requires a ${relDef.from} from-node (got ${fromLabels.join(',') || 'none'})`,
        'ENDPOINT_LABEL_MISMATCH',
      );
    }
    if (relDef.to && !toLabels.includes(relDef.to)) {
      throw new RelationEditValidationError(
        `${type} requires a ${relDef.to} to-node (got ${toLabels.join(',') || 'none'})`,
        'ENDPOINT_LABEL_MISMATCH',
      );
    }
  }

  /**
   * Enforce the schema's declared `cardinality` for this relation type, read as
   * `from:to`. Run the check in only the constrained direction(s), counting
   * edges of this type from ALL sources (connector + manual) — cardinality is a
   * graph-model invariant, so an existing connector edge still blocks a
   * conflicting manual one. Each query EXCLUDES the (from,to) pair itself
   * (`other.id <> ...`), so re-adding the exact same edge is never a violation
   * (the MERGE then resolves it as an idempotent no-op).
   *
   *   - N:M → unconstrained (no check).
   *   - N:1 → FROM side capped: reject if `from` already has a `[:TYPE]->` edge
   *     to a node OTHER THAN `to`.
   *   - 1:N → TO side capped: reject if `to` already has a `<-[:TYPE]-` edge
   *     from a node OTHER THAN `from`.
   *   - 1:1 → BOTH caps apply.
   */
  private async assertCardinality(
    tx: ManagedTransaction,
    relDef: { cardinality?: string },
    from: string,
    to: string,
    type: string,
    safeType: string,
  ): Promise<void> {
    const cardinality = relDef.cardinality;
    if (!cardinality || cardinality === 'N:M') return;

    // FROM-side cap (N:1, 1:1): `from` may have at most one outgoing edge of
    // this type. Reject if it already points at a DIFFERENT node than `to`.
    if (cardinality === 'N:1' || cardinality === '1:1') {
      const res = await tx.run(
        `MATCH (from {id: $from})-[r:${safeType}]->(other)
         WHERE other.id <> $to
         RETURN other.id AS conflict LIMIT 1`,
        { from, to },
      );
      const conflict = res.records[0]?.get('conflict') as string | undefined;
      if (conflict != null) {
        throw new RelationEditConflictError(
          `${type} is ${cardinality}: ${from} may have only one outgoing ${type} ` +
            `edge, but it already points to ${conflict}`,
          'CARDINALITY_VIOLATION',
        );
      }
    }

    // TO-side cap (1:N, 1:1): `to` may have at most one incoming edge of this
    // type. Reject if it already has one from a DIFFERENT node than `from`.
    if (cardinality === '1:N' || cardinality === '1:1') {
      const res = await tx.run(
        `MATCH (other)-[r:${safeType}]->(to {id: $to})
         WHERE other.id <> $from
         RETURN other.id AS conflict LIMIT 1`,
        { from, to },
      );
      const conflict = res.records[0]?.get('conflict') as string | undefined;
      if (conflict != null) {
        throw new RelationEditConflictError(
          `${type} is ${cardinality}: ${to} may have only one incoming ${type} ` +
            `edge, but it already comes from ${conflict}`,
          'CARDINALITY_VIOLATION',
        );
      }
    }
  }

  private async loadEndpoints(
    tx: ManagedTransaction,
    from: string,
    to: string,
  ): Promise<{
    fromExists: boolean;
    toExists: boolean;
    fromLabels: string[];
    toLabels: string[];
  }> {
    const res = await tx.run(
      `OPTIONAL MATCH (from {id: $from})
       OPTIONAL MATCH (to {id: $to})
       RETURN from IS NOT NULL AS fromExists,
              to IS NOT NULL AS toExists,
              labels(from) AS fromLabels,
              labels(to) AS toLabels`,
      { from, to },
    );
    const r = res.records[0];
    return {
      fromExists: r?.get('fromExists') === true,
      toExists: r?.get('toExists') === true,
      fromLabels: (r?.get('fromLabels') as string[] | null) ?? [],
      toLabels: (r?.get('toLabels') as string[] | null) ?? [],
    };
  }

  private async recordEvent(
    tx: ManagedTransaction,
    e: {
      kind: 'relation_added' | 'relation_removed';
      actor: string;
      from: string;
      to: string;
      type: string;
    },
  ): Promise<void> {
    // Same tx as the edge write → atomic. The audit node is anchored to the
    // from-node via the internal EDITS relationship (excluded from graph stats).
    await tx.run(
      `MATCH (n {id: $from})
       CREATE (e:GraphEditEvent {
         id: $id, kind: $kind, actor: $actor,
         from_id: $from, to_id: $to, relation_type: $type,
         ts: datetime()
       })
       CREATE (e)-[:EDITS]->(n)`,
      {
        id: `ge:${randomUUID()}`,
        kind: e.kind,
        actor: e.actor,
        from: e.from,
        to: e.to,
        type: e.type,
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
