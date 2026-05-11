import type { ManagedTransaction } from 'neo4j-driver';
import type { CanonicalNode, CanonicalEdge, PropertyClaim } from '@shipit-ai/shared';

export async function mergeNode(
  tx: ManagedTransaction,
  node: CanonicalNode,
  mergedClaims: PropertyClaim[],
  effectiveProperties: Record<string, unknown>,
): Promise<void> {
  // Build effective property keys (e.g., name -> name_effective)
  const effectiveProps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(effectiveProperties)) {
    effectiveProps[key] = value;
  }

  const query = `
    MERGE (n:${sanitizeLabel(node.label)} {id: $id})
    SET n += $properties,
        n += $effectiveProps,
        n._claims = $claims,
        n._last_synced = $lastSynced,
        n._source_system = $sourceSystem,
        n._source_org = $sourceOrg,
        n._source_id = $sourceId,
        n._event_version = $eventVersion
  `;

  await tx.run(query, {
    id: node.id,
    properties: sanitizeProperties(node.properties),
    effectiveProps: sanitizeProperties(effectiveProps),
    claims: JSON.stringify(mergedClaims),
    lastSynced: node._last_synced,
    sourceSystem: node._source_system,
    sourceOrg: node._source_org,
    sourceId: node._source_id,
    eventVersion:
      typeof node._event_version === 'number' ? node._event_version : node._event_version,
  });
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
 */
function sanitizeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_]/g, '_');
}

/**
 * Sanitize properties for Neo4j (convert non-primitive values to JSON strings).
 */
function sanitizeProperties(props: Record<string, unknown>): Record<string, unknown> {
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
