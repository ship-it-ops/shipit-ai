// Forward-only Neo4j migrations the core-writer runs on every startup.
//
// Migrations here must be idempotent and cheap when there's nothing to do —
// they run on every boot. The next full sync re-populates anything they
// delete.
import type { Neo4jClient } from './client.js';

const SCOPED_LABELS = ['repository', 'team', 'pipeline'] as const;

export interface CanonicalIdMigrationStats {
  nodesDeleted: Record<(typeof SCOPED_LABELS)[number], number>;
  linkingKeysDeleted: Record<(typeof SCOPED_LABELS)[number], number>;
  idempotencyEntriesDeleted: Record<(typeof SCOPED_LABELS)[number], number>;
}

/**
 * One-shot cleanup for the canonical-ID org-namespacing change.
 *
 * Before the change, Repository/Team/Pipeline IDs were
 * `shipit://<label>/default/<name>` and silently collapsed across orgs that
 * shared a name. The new format is `shipit://<label>/default/<org>/<name>`.
 *
 * For each scoped label (`repository`, `team`, `pipeline`) this function:
 *   1. Deletes nodes whose `id` matches the old single-segment shape
 *      (regex `^shipit://<label>/default/[^/]+$`). New-format IDs
 *      (`shipit://<label>/default/<org>/<name>`) are left alone.
 *   2. Deletes matching `_LinkingKey` entries.
 *   3. Deletes `_IdempotencyLog` entries that reference ANY canonical ID
 *      of this label, both old and new format. This is the critical bit:
 *      otherwise the writer's idempotency check fires before writeNode is
 *      attempted, the sync no-ops, and the wiped nodes never get re-created.
 *      We're forcing a full re-sync of these entities so clearing dedup is
 *      exactly the right move.
 *
 * Runs unconditionally on every boot; once everyone's migrated it's
 * effectively a no-op (queries that match zero rows).
 */
export async function runCanonicalIdMigration(
  client: Neo4jClient,
): Promise<CanonicalIdMigrationStats> {
  const nodesDeleted = {} as CanonicalIdMigrationStats['nodesDeleted'];
  const linkingKeysDeleted = {} as CanonicalIdMigrationStats['linkingKeysDeleted'];
  const idempotencyEntriesDeleted = {} as CanonicalIdMigrationStats['idempotencyEntriesDeleted'];

  for (const label of SCOPED_LABELS) {
    const oldPrefix = `shipit://${label}/default/`;
    const oldShapeRegex = `^shipit://${label}/default/[^/]+$`;

    const nodeCount = await client.executeWrite(async (tx) => {
      const result = await tx.run(
        `MATCH (n) WHERE n.id STARTS WITH $prefix AND n.id =~ $regex
         DETACH DELETE n RETURN count(n) AS deleted`,
        { prefix: oldPrefix, regex: oldShapeRegex },
      );
      const raw = result.records[0]?.get('deleted');
      return typeof raw === 'object' && raw !== null && 'toNumber' in raw
        ? (raw as { toNumber(): number }).toNumber()
        : Number(raw ?? 0);
    });
    nodesDeleted[label] = nodeCount;

    const linkingKeyCount = await client.executeWrite(async (tx) => {
      const result = await tx.run(
        `MATCH (lk:_LinkingKey)
         WHERE lk.canonical_id STARTS WITH $prefix AND lk.canonical_id =~ $regex
         DELETE lk RETURN count(lk) AS deleted`,
        { prefix: oldPrefix, regex: oldShapeRegex },
      );
      const raw = result.records[0]?.get('deleted');
      return typeof raw === 'object' && raw !== null && 'toNumber' in raw
        ? (raw as { toNumber(): number }).toNumber()
        : Number(raw ?? 0);
    });
    linkingKeysDeleted[label] = linkingKeyCount;

    // Also clear idempotency entries that reference ANY canonical ID of this
    // label (both old and new format). Without this, a previously-recorded
    // write blocks the writer from re-creating a node that was wiped: the
    // dedup check fires before writeNode is ever attempted, and the sync
    // silently no-ops. Idempotency keys have the shape
    // `<connector_id>:<canonical_id>:<event_version>`, so we match on the
    // canonical-ID substring.
    const idempotencyCount = await client.executeWrite(async (tx) => {
      const result = await tx.run(
        `MATCH (i:_IdempotencyLog)
         WHERE i.key CONTAINS $marker
         DELETE i RETURN count(i) AS deleted`,
        { marker: `:${oldPrefix}` },
      );
      const raw = result.records[0]?.get('deleted');
      return typeof raw === 'object' && raw !== null && 'toNumber' in raw
        ? (raw as { toNumber(): number }).toNumber()
        : Number(raw ?? 0);
    });
    idempotencyEntriesDeleted[label] = idempotencyCount;
  }

  return { nodesDeleted, linkingKeysDeleted, idempotencyEntriesDeleted };
}
