import type { ManagedTransaction } from 'neo4j-driver';
import type { CanonicalNode, CanonicalEdge, PropertyClaim } from '@shipit-ai/shared';

/**
 * Atomically upsert a node with a FRESHNESS GUARD (Cut B).
 *
 * The compare-and-set is a SINGLE Cypher transaction (not an app-level
 * read-then-write) so it is correct under BullMQ worker concurrency, multiple
 * core-writer replicas, and managed-transaction retries — the read-then-write
 * variant is a TOCTOU race that lets an older delivery overwrite newer state.
 * It also sidesteps neo4j-driver lossless-Integer typing: the comparison runs
 * against the live stored value in Cypher using native numeric ordering, so
 * there is no JS `typeof`/`toNumber` dance on the stored side.
 *
 * Reject (skip the content write, keep stored) iff the incoming version is
 * COMPARABLE (a finite epoch number) AND the stored version is STRICTLY greater.
 * Strict `>` (not `>=`) is deliberate: equal-version-but-different-content already
 * passed the content-hash dedup layer, so it is a real change and must be written
 * (last-writer-wins for the same instant). All other cases write:
 *   - first write (stored null), incomparable incoming (content-hash version),
 *   - legacy stored `1` vs an epoch (1 > epoch is false), and
 *   - a stored string vs a numeric incoming (`string > number` → null → not rejected).
 *
 * Returns `true` when the node was written, `false` when the guard rejected it.
 */
export async function mergeNode(
  tx: ManagedTransaction,
  node: CanonicalNode,
  mergedClaims: PropertyClaim[],
  effectiveProperties: Record<string, unknown>,
): Promise<boolean> {
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

  const query = `
    MERGE (n:${sanitizeLabel(node.label)} {id: $id})
    WITH n, coalesce(
      $comparable AND n._event_version IS NOT NULL AND n._event_version > $incoming,
      false
    ) AS reject
    FOREACH (_ IN CASE WHEN reject THEN [] ELSE [1] END |
      SET n += $properties,
          n += $effectiveProps,
          n._claims = $claims,
          n._last_synced = $lastSynced,
          n._source_system = $sourceSystem,
          n._source_org = $sourceOrg,
          n._source_id = $sourceId,
          n._source_connector_id = $sourceConnectorId,
          n._event_version = $eventVersion
    )
    RETURN NOT reject AS written
  `;

  const result = await tx.run(query, {
    id: node.id,
    comparable,
    incoming,
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
  return result.records[0]?.get('written') === true;
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

export async function getExistingClaims(
  tx: ManagedTransaction,
  nodeId: string,
): Promise<PropertyClaim[]> {
  const result = await tx.run(`MATCH (n {id: $id}) RETURN n._claims AS claims`, { id: nodeId });
  if (result.records.length === 0) return [];
  const claimsJson = result.records[0].get('claims');
  if (!claimsJson) return [];
  try {
    return JSON.parse(claimsJson as string) as PropertyClaim[];
  } catch {
    return [];
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
