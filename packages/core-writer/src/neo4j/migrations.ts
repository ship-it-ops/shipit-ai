// Forward-only Neo4j migrations the core-writer runs on every startup.
//
// Migrations here must be idempotent and cheap when there's nothing to do —
// they run on every boot. The next full sync re-populates anything they
// delete.
import type { Neo4jClient } from './client.js';

const SCOPED_LABELS = ['repository', 'team', 'pipeline'] as const;

type ScopedLabel = (typeof SCOPED_LABELS)[number];

/**
 * Regex matching the OLD single-segment canonical-ID shape for a scoped label.
 * NEW IDs include `<org>/<name>` so the slash in the name segment stops the
 * `[^/]+` match. Anchored — Cypher `=~` requires full-string match.
 */
export function buildOldCanonicalIdRegex(label: ScopedLabel): string {
  return `^shipit://${label}/default/[^/]+$`;
}

/**
 * Regex matching idempotency-log keys whose canonical-ID portion is OLD-format.
 *
 * `_IdempotencyLog.key` is the BullMQ job ID built by `buildIdempotencyKey()`
 * in event-bus, which substitutes `~` for every `:` before storage (BullMQ 5
 * rejects `:` in custom job IDs; see
 * docs/agent/scars/bullmq-5-forbids-colons-in-queue-names-and-job-ids.md).
 * So stored keys have the shape
 *   `<connector_id>~shipit~//<label>/default/<name>~<event_version>`
 *
 * `[^/~]+` excludes new-format IDs — their `<org>/<name>` portion contains a
 * `/`, and `~` is the separator before `<event_version>`.
 */
export function buildOldIdempotencyKeyRegex(label: ScopedLabel): string {
  return `.*~shipit~//${label}/default/[^/~]+~.*`;
}

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
 *   3. Deletes `_IdempotencyLog` entries whose key references an OLD-format
 *      canonical ID. Without this, the orphan dedup entry blocks the writer
 *      from re-creating the wiped node — the idempotency check fires before
 *      writeNode is attempted and the sync silently no-ops. New-format
 *      entries are preserved so within-session dedup still works.
 *
 * All three queries match zero rows once everyone's migrated, so the
 * migration runs unconditionally on every boot at near-zero cost.
 */
export async function runCanonicalIdMigration(
  client: Neo4jClient,
): Promise<CanonicalIdMigrationStats> {
  const nodesDeleted = {} as CanonicalIdMigrationStats['nodesDeleted'];
  const linkingKeysDeleted = {} as CanonicalIdMigrationStats['linkingKeysDeleted'];
  const idempotencyEntriesDeleted = {} as CanonicalIdMigrationStats['idempotencyEntriesDeleted'];

  for (const label of SCOPED_LABELS) {
    const oldPrefix = `shipit://${label}/default/`;
    const oldShapeRegex = buildOldCanonicalIdRegex(label);

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

    // Also clear `_IdempotencyLog` entries that reference an OLD-format
    // canonical ID of this label. Without this, the orphan idempotency entry
    // blocks the writer from re-creating the wiped node — the dedup check
    // fires before writeNode is ever attempted, and the sync silently no-ops.
    // See `buildOldIdempotencyKeyRegex` for the stored key shape (`~` not `:`).
    const oldKeyRegex = buildOldIdempotencyKeyRegex(label);
    const idempotencyCount = await client.executeWrite(async (tx) => {
      const result = await tx.run(
        `MATCH (i:_IdempotencyLog) WHERE i.key =~ $regex
         DELETE i RETURN count(i) AS deleted`,
        { regex: oldKeyRegex },
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
