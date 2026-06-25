// Shared locked read-modify-write primitives for the node `_claims` array.
//
// Both VerificationService and ManualEditService mutate a node's `_claims` under
// the same `_claims_rev` lock authority that api-server and core-writer agree on
// (see T0: core-writer's mergeNode now compares-and-sets `_claims_rev`). Factored
// here so the locking contract lives in ONE place rather than being copy-pasted
// per write service — a divergence would silently re-open the lost-update race.
import type { ManagedTransaction } from 'neo4j-driver';
import type { PropertyClaim } from '@shipit-ai/shared';

/** Node identity + claims captured under the write lock. */
export interface LockedClaims {
  claims: PropertyClaim[];
  name: string;
  label: string;
}

/** Tolerant `_claims` decode: array, JSON string, or (corrupt/absent) → []. */
export function parseClaims(raw: unknown): PropertyClaim[] {
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

/**
 * Read a node's claims while holding its write lock, inside `tx`. The SET forces
 * Neo4j to take the node's write lock immediately, so a concurrent
 * verify/manual-edit/resolve transaction blocks here until this one commits and
 * then re-reads the latest claims — turning a lost-update race into serialized
 * writes. `_claims_rev` is `_`-prefixed (hidden from user-facing queries) and is
 * the single lock authority both api-server and core-writer honor.
 *
 * Returns null when the node does not exist.
 */
export async function loadClaimsLocked(
  tx: ManagedTransaction,
  entityId: string,
): Promise<LockedClaims | null> {
  const result = await tx.run(
    `MATCH (n {id: $id})
     SET n._claims_rev = coalesce(n._claims_rev, 0) + 1
     RETURN n, labels(n) AS labels LIMIT 1`,
    { id: entityId },
  );
  if (result.records.length === 0) return null;
  const node = result.records[0].get('n') as { properties: Record<string, unknown> };
  const labels = result.records[0].get('labels') as string[];
  return {
    claims: parseClaims(node.properties._claims),
    name: String(node.properties.name ?? entityId.split('/').pop() ?? entityId),
    label: labels[0] ?? 'Unknown',
  };
}

/** Persist the full claims array back to the node, inside `tx`. */
export async function writeClaims(
  tx: ManagedTransaction,
  entityId: string,
  claims: PropertyClaim[],
): Promise<void> {
  await tx.run('MATCH (n {id: $id}) SET n._claims = $claims', {
    id: entityId,
    claims: JSON.stringify(claims),
  });
}
