import type { ManagedTransaction } from 'neo4j-driver';
import type { CanonicalNode, CanonicalEdge, PropertyClaim } from '@shipit-ai/shared';

/** Outcome of {@link mergeNode}.
 *  - `written` — the existing FRESHNESS-guard verdict: false ⇒ a strictly-newer
 *    `_event_version` is already stored, so NOTHING was written. Unchanged meaning
 *    (the batch processor still counts this as a freshness-skip).
 *  - `claimsWritten` — whether the `_claims`/derived-property portion was written
 *    AND `_claims_rev` bumped. Implies `written` (a freshness reject writes nothing).
 *  - `claimsConflict` — the NEW optimistic-concurrency verdict: true ⇒ the freshness
 *    guard passed (node content was written) but `_claims_rev` changed since the read,
 *    so the claims write was SKIPPED to avoid clobbering a concurrent manual edit.
 *    The caller should re-read + re-resolve claims and retry. */
export interface MergeNodeResult {
  written: boolean;
  claimsWritten: boolean;
  claimsConflict: boolean;
}

/**
 * Atomically upsert a node with TWO compare-and-set guards (both inside one
 * Cypher tx, so both are correct under BullMQ concurrency, multiple core-writer
 * replicas, and managed-tx retries — never an app-level read-then-write TOCTOU):
 *
 * 1. FRESHNESS GUARD (Cut B) on `_event_version`. Reject (skip the content write,
 *    keep stored) iff the incoming version is COMPARABLE (a finite epoch number)
 *    AND the stored version is STRICTLY greater. Strict `>` (not `>=`) is
 *    deliberate: equal-version-but-different-content already passed the
 *    content-hash dedup layer, so it is a real change and must be written
 *    (last-writer-wins for the same instant). All other cases write:
 *      - first write (stored null), incomparable incoming (content-hash version),
 *      - legacy stored `1` vs an epoch (1 > epoch is false), and
 *      - a stored string vs a numeric incoming (`string > number` → null → not rejected).
 *
 * 2. CLAIMS OPTIMISTIC-CONCURRENCY GUARD on `_claims_rev`. api-server's manual-edit
 *    writers (VerificationService) take a write-lock by bumping `_claims_rev` in a
 *    single tx. core-writer is NOT a participant in that lock, so without this guard
 *    a connector resync that read `_claims` at T0 would clobber a manual claim an
 *    api-server writer committed at T1. We require the CURRENT stored `_claims_rev`
 *    (coalesced null→0) to still equal `expectedClaimsRev` captured at read time; if
 *    it changed, we skip the `_claims`/derived-property write (a `claimsConflict`)
 *    so the caller can re-read + re-resolve on top of the concurrent edit. On a
 *    successful claims write we bump `_claims_rev` so we, too, advance the lock.
 *
 * The two guards are INDEPENDENT and BOTH must pass to write claims. The freshness
 * guard still gates ALL writes (`written:false` ⇒ a stale delivery wrote nothing —
 * unchanged Cut-B semantics); the claims guard additionally gates ONLY the
 * `_claims`/derived-property portion. A `claimsConflict` keeps `written:true` (the
 * properties/source/version were still refreshed) but reports `claimsWritten:false`
 * WITHOUT touching `_claims`, so the caller re-reads + re-resolves and retries.
 *
 * rev/version are bound parameters (never interpolated) — injection-safe.
 */
export async function mergeNode(
  tx: ManagedTransaction,
  node: CanonicalNode,
  mergedClaims: PropertyClaim[],
  effectiveProperties: Record<string, unknown>,
  expectedClaimsRev = 0,
): Promise<MergeNodeResult> {
  // Build effective property keys (e.g., name -> name_effective)
  const effectiveProps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(effectiveProperties)) {
    effectiveProps[key] = value;
  }

  // Only a finite epoch-ms number is chronologically orderable. Content-hash
  // versions (sentinel-prefixed strings) are opaque → not comparable → always write.
  const comparable =
    typeof node._event_version === 'number' && Number.isFinite(node._event_version);
  const incoming = comparable ? (node._event_version as number) : null;

  // Two guards: `reject` skips ALL writes (freshness); `claimsConflict` skips only
  // the claims/derived-property portion (lost-update protection on `_claims_rev`).
  // A freshness reject implies no claims write either, so claimsConflict is only
  // meaningful when the freshness guard passes.
  const query = `
    MERGE (n:${sanitizeLabel(node.label)} {id: $id})
    WITH n, coalesce(
      $comparable AND n._event_version IS NOT NULL AND n._event_version > $incoming,
      false
    ) AS reject
    WITH n, reject,
      (NOT reject AND coalesce(n._claims_rev, 0) <> $expectedClaimsRev) AS claimsConflict
    FOREACH (_ IN CASE WHEN reject THEN [] ELSE [1] END |
      SET n += $properties,
          n._last_synced = $lastSynced,
          n._source_system = $sourceSystem,
          n._source_org = $sourceOrg,
          n._source_id = $sourceId,
          n._source_connector_id = $sourceConnectorId,
          n._event_version = $eventVersion
    )
    FOREACH (_ IN CASE WHEN (NOT reject AND NOT claimsConflict) THEN [1] ELSE [] END |
      SET n += $effectiveProps,
          n._claims = $claims,
          n._claims_rev = coalesce(n._claims_rev, 0) + 1
    )
    RETURN (NOT reject) AS written,
           (NOT reject AND NOT claimsConflict) AS claimsWritten,
           claimsConflict
  `;

  const result = await tx.run(query, {
    id: node.id,
    comparable,
    incoming,
    expectedClaimsRev,
    properties: sanitizeProperties(node.properties),
    effectiveProps: sanitizeProperties(effectiveProps),
    claims: JSON.stringify(mergedClaims),
    lastSynced: node._last_synced,
    sourceSystem: node._source_system,
    sourceOrg: node._source_org,
    sourceId: node._source_id,
    // Overwrite on every write — matches the semantics of _source_system /
    // _source_id (most-recent writer wins). Per-claim provenance is still
    // preserved in `_claims` for the resolver.
    sourceConnectorId: node._source_connector_id ?? null,
    eventVersion: node._event_version,
  });
  const record = result.records[0];
  return {
    written: record?.get('written') === true,
    claimsWritten: record?.get('claimsWritten') === true,
    claimsConflict: record?.get('claimsConflict') === true,
  };
}

/**
 * Refresh only `_last_synced` on an existing node — no claim/property writes.
 * Used on the idempotent-skip path so an unchanged-but-re-confirmed entity's
 * "Synced" time advances. Conditional + monotonic: only ADVANCES `_last_synced`
 * (ISO-8601 sorts chronologically as a string), never moves it backward — a
 * replayed/retried OLDER delivery whose content key is already recorded must not
 * drag a fresher node's "Synced" time back. No-ops if the node doesn't exist yet.
 */
export async function touchLastSynced(
  tx: ManagedTransaction,
  nodeId: string,
  lastSynced: string,
): Promise<void> {
  await tx.run(
    `MATCH (n {id: $id})
     WHERE n._last_synced IS NULL OR n._last_synced < $lastSynced
     SET n._last_synced = $lastSynced`,
    { id: nodeId, lastSynced },
  );
}

export async function mergeEdge(tx: ManagedTransaction, edge: CanonicalEdge): Promise<void> {
  const query = `
    MATCH (from {id: $fromId})
    MATCH (to {id: $toId})
    MERGE (from)-[r:${sanitizeLabel(edge.type)}]->(to)
    SET r += $properties,
        r._source = $source,
        r._confidence = $confidence,
        r._ingested_at = $ingestedAt
  `;

  await tx.run(query, {
    fromId: edge.from,
    toId: edge.to,
    properties: sanitizeProperties(edge.properties ?? {}),
    source: edge._source,
    confidence: edge._confidence,
    ingestedAt: edge._ingested_at,
  });
}

export async function checkIdempotencyKey(tx: ManagedTransaction, key: string): Promise<boolean> {
  const result = await tx.run(`MATCH (i:_IdempotencyLog {key: $key}) RETURN i.key AS key`, { key });
  return result.records.length > 0;
}

export async function writeIdempotencyKey(
  tx: ManagedTransaction,
  key: string,
  ttlDays: number,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
  await tx.run(
    `MERGE (i:_IdempotencyLog {key: $key})
     SET i.created_at = $createdAt, i.expires_at = $expiresAt`,
    { key, createdAt: new Date().toISOString(), expiresAt },
  );
}

export async function registerLinkingKey(
  tx: ManagedTransaction,
  canonicalId: string,
  linkingKey: string,
): Promise<void> {
  await tx.run(
    `MERGE (lk:_LinkingKey {linking_key: $linkingKey})
     SET lk.canonical_id = $canonicalId, lk.updated_at = $updatedAt`,
    {
      linkingKey,
      canonicalId,
      updatedAt: new Date().toISOString(),
    },
  );
}

export async function lookupLinkingKey(
  tx: ManagedTransaction,
  linkingKey: string,
): Promise<string | null> {
  const result = await tx.run(
    `MATCH (lk:_LinkingKey {linking_key: $linkingKey}) RETURN lk.canonical_id AS canonicalId`,
    { linkingKey },
  );
  if (result.records.length > 0) {
    return result.records[0].get('canonicalId') as string;
  }
  return null;
}

export async function cleanupExpiredIdempotencyKeys(tx: ManagedTransaction): Promise<number> {
  const result = await tx.run(
    `MATCH (i:_IdempotencyLog)
     WHERE i.expires_at < $now
     DELETE i
     RETURN count(i) AS deleted`,
    { now: new Date().toISOString() },
  );
  const deleted = result.records[0]?.get('deleted');
  return typeof deleted === 'object' && deleted !== null && 'toNumber' in deleted
    ? (deleted as { toNumber(): number }).toNumber()
    : Number(deleted ?? 0);
}

/** Existing claims plus the node's current `_claims_rev` (null coalesced → 0).
 *  `claimsRev` is captured at READ time and threaded into the next {@link mergeNode}
 *  as `expectedClaimsRev` for optimistic-concurrency control against api-server's
 *  manual-edit writers, which bump `_claims_rev` under their own write-lock. */
export interface ExistingClaims {
  claims: PropertyClaim[];
  claimsRev: number;
}

/** Coerce a neo4j-driver value (lossless `Integer`, plain number, or null) to a
 *  JS number, defaulting a missing/unparseable `_claims_rev` to 0. */
function toRev(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'object' && 'toNumber' in value) {
    return (value as { toNumber(): number }).toNumber();
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function getExistingClaims(
  tx: ManagedTransaction,
  nodeId: string,
): Promise<ExistingClaims> {
  const result = await tx.run(
    `MATCH (n {id: $id}) RETURN n._claims AS claims, n._claims_rev AS claimsRev`,
    { id: nodeId },
  );
  if (result.records.length === 0) return { claims: [], claimsRev: 0 };
  const claimsRev = toRev(result.records[0].get('claimsRev'));
  const claimsJson = result.records[0].get('claims');
  if (!claimsJson) return { claims: [], claimsRev };
  try {
    return { claims: JSON.parse(claimsJson as string) as PropertyClaim[], claimsRev };
  } catch {
    return { claims: [], claimsRev };
  }
}

/**
 * Sanitize a label/type for safe use in Cypher.
 * Only allows alphanumeric and underscore characters.
 *
 * Exported for unit testing: this output is interpolated DIRECTLY into Cypher
 * (`MERGE (n:${sanitizeLabel(...)} ...)`), unlike property values which go
 * through bound parameters — so its behavior is injection-relevant and locked
 * by tests in queries.test.ts.
 */
export function sanitizeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Sanitize properties for Neo4j (convert non-primitive values to JSON strings).
 * Exported for unit testing.
 */
export function sanitizeProperties(props: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (key.startsWith('_')) continue; // Skip internal properties
    if (value === null || value === undefined) {
      result[key] = null;
    } else if (typeof value === 'object') {
      result[key] = JSON.stringify(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}
