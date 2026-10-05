// Every SQL statement of the knowledge layer, grouped by table. Callers never
// write SQL. Ids are UUIDs minted here; timestamps are set by Postgres.
import { randomUUID } from 'node:crypto';
import type { Db, SqlClient } from '@shipit-ai/agents';
import { KnowledgeContainerChanged } from '@shipit-ai/connector-sdk';
import type {
  ChangeBatch,
  ContainerKind,
  ContainerVisibility,
  DocumentKind,
  DocumentSegment,
  DocumentState,
  KnowledgeRunMode,
  PruneOptions,
  SelectedContainer,
  SourceAcl,
  SourceContainer,
  SourcePrincipal,
} from '@shipit-ai/connector-sdk';
import { contentHashOf } from './hash.js';

export const CLAIM_STALE_MS = 10 * 60_000;
export const MAX_INDEX_ATTEMPTS = 5;

export interface ContainerRow {
  id: string;
  connectorId: string;
  externalId: string;
  kind: ContainerKind;
  name: string;
  url: string | null;
  visibility: ContainerVisibility;
  archived: boolean;
  acl: SourceAcl | null;
  selected: boolean;
  selectedBy: string | null;
  checkpoint: string | null;
  mappedEntityIds: string[];
  lastPolledAt: string | null;
  lastReconciledAt: string | null;
  goneAt: string | null;
  purgeRequestedAt: string | null;
}

export interface ContainerSummary extends ContainerRow {
  visibilityAcknowledgedBy: string | null;
  /** Documents with content: not deleted, not restricted stubs. */
  documents: number;
  indexed: number;
  pending: number;
  failed: number;
  /** Items excluded because the source restricts them. */
  restricted: number;
}

export interface DocumentRow {
  id: string;
  connectorId: string;
  containerId: string;
  externalId: string;
  kind: DocumentKind;
  title: string;
  url: string;
  segments: DocumentSegment[];
  contentHash: string | null;
  sourceVersion: string | null;
  sourceCreatedAt: string | null;
  sourceUpdatedAt: string | null;
  authorPrincipalId: string | null;
  participantPrincipalIds: string[];
  state: DocumentState | null;
  attributes: Record<string, unknown>;
  restricted: boolean;
  redactions: number;
  indexStatus: 'pending' | 'indexing' | 'indexed' | 'failed' | 'skipped';
  indexAttempts: number;
  indexError: string | null;
  indexedHash: string | null;
  indexVersion: number | null;
  deletedAt: string | null;
}

export interface StoredChunkInput {
  seq: number;
  segmentKeys: string[];
  url?: string;
  occurredAt?: string;
  prefix: string;
  text: string;
  textHash: string;
  tokenEstimate: number;
  /** pgvector literal from toPgVector(). */
  embedding: string;
  embeddingModel: string;
}

const CONTAINER_COLUMNS = `id, connector_id, external_id, kind, name, url, visibility, archived, acl,
  selected, selected_by, checkpoint, mapped_entity_ids, last_polled_at, last_reconciled_at, gone_at, purge_requested_at`;

const DOCUMENT_COLUMNS = `id, connector_id, container_id, external_id, kind, title, url, segments, content_hash,
  source_version, source_created_at, source_updated_at, author_principal_id, participant_principal_ids, state,
  attributes, restricted, redactions, index_status, index_attempts, index_error, indexed_hash, index_version, deleted_at`;

type Raw = Record<string, unknown>;
const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v == null ? null : String(v);

function containerRow(r: Raw): ContainerRow {
  return {
    id: r.id as string,
    connectorId: r.connector_id as string,
    externalId: r.external_id as string,
    kind: r.kind as ContainerKind,
    name: r.name as string,
    url: (r.url as string | null) ?? null,
    visibility: r.visibility as ContainerVisibility,
    archived: r.archived as boolean,
    acl: (r.acl as SourceAcl | null) ?? null,
    selected: r.selected as boolean,
    selectedBy: (r.selected_by as string | null) ?? null,
    checkpoint: (r.checkpoint as string | null) ?? null,
    mappedEntityIds: (r.mapped_entity_ids as string[]) ?? [],
    lastPolledAt: iso(r.last_polled_at),
    lastReconciledAt: iso(r.last_reconciled_at),
    goneAt: iso(r.gone_at),
    purgeRequestedAt: iso(r.purge_requested_at),
  };
}

function documentRow(r: Raw): DocumentRow {
  return {
    id: r.id as string,
    connectorId: r.connector_id as string,
    containerId: r.container_id as string,
    externalId: r.external_id as string,
    kind: r.kind as DocumentKind,
    title: r.title as string,
    url: r.url as string,
    segments: (r.segments as DocumentSegment[]) ?? [],
    contentHash: (r.content_hash as string | null) ?? null,
    sourceVersion: (r.source_version as string | null) ?? null,
    sourceCreatedAt: iso(r.source_created_at),
    sourceUpdatedAt: iso(r.source_updated_at),
    authorPrincipalId: (r.author_principal_id as string | null) ?? null,
    participantPrincipalIds: (r.participant_principal_ids as string[]) ?? [],
    state: (r.state as DocumentState | null) ?? null,
    attributes: (r.attributes as Record<string, unknown>) ?? {},
    restricted: r.restricted as boolean,
    redactions: Number(r.redactions ?? 0),
    indexStatus: r.index_status as DocumentRow['indexStatus'],
    indexAttempts: Number(r.index_attempts ?? 0),
    indexError: (r.index_error as string | null) ?? null,
    indexedHash: (r.indexed_hash as string | null) ?? null,
    indexVersion: r.index_version == null ? null : Number(r.index_version),
    deletedAt: iso(r.deleted_at),
  };
}

function toSelected(row: ContainerRow): SelectedContainer {
  return {
    externalId: row.externalId,
    kind: row.kind,
    name: row.name,
    url: row.url ?? undefined,
    visibility: row.visibility,
    archived: row.archived,
    acl: row.acl ?? undefined,
    checkpoint: row.checkpoint,
  };
}

async function upsertPrincipalRows(
  client: SqlClient,
  connectorId: string,
  principals: SourcePrincipal[],
): Promise<void> {
  for (const p of principals) {
    await client.query(
      `INSERT INTO knowledge_principals (id, connector_id, external_id, kind, display_name, email, login, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (connector_id, external_id) DO UPDATE SET
         kind = EXCLUDED.kind, display_name = EXCLUDED.display_name,
         email = COALESCE(EXCLUDED.email, knowledge_principals.email),
         login = COALESCE(EXCLUDED.login, knowledge_principals.login),
         active = EXCLUDED.active, updated_at = now()`,
      [
        randomUUID(),
        connectorId,
        p.externalId,
        p.kind,
        p.displayName,
        p.email ?? null,
        p.login ?? null,
        p.active,
      ],
    );
  }
}

// True for a connector id that has nothing selected, nothing stored and no
// purge pending: the condition under which its people are not held.
const NOTHING_REFERS_TO = (connectorId: string): string => `NOT EXISTS (
  SELECT 1 FROM knowledge_containers c
   WHERE c.connector_id = ${connectorId}
     AND (c.selected OR c.purge_requested_at IS NOT NULL
          OR EXISTS (SELECT 1 FROM knowledge_documents d WHERE d.container_id = c.id)))`;

const lifeKey = (connectorId: string): string => `connector-life:${connectorId}`;

// A document row that is still the claim a worker took for the content hash in
// $2: being indexed, same content, not deleted, not restricted. The sink may
// have tombstoned, restricted or edited the document since, and an edited one
// may have been claimed again.
const STILL_THE_CLAIM = `index_status = 'indexing' AND content_hash = $2
            AND deleted_at IS NULL AND NOT restricted`;

/**
 * Removes everything a connector id holds. Shared by a delete and by the
 * start of a new connector under a used id; runs inside the caller's
 * transaction.
 */
async function clearConnector(tx: SqlClient, connectorId: string, by: string): Promise<number> {
  // Nothing to wait for: an empty container goes now. Marking it for the
  // worker instead would queue thousands of empty rows ahead of real purges.
  const emptied = await tx.query(
    `DELETE FROM knowledge_containers c
      WHERE c.connector_id = $1
        AND NOT EXISTS (SELECT 1 FROM knowledge_documents d WHERE d.container_id = c.id)`,
    [connectorId],
  );
  // Only rows not already on their way out: clearing again (a delete tried
  // twice, a new connector's check while the old one's purge is pending) is
  // then nothing, and the count is what this call changed.
  const marked = await tx.query(
    `UPDATE knowledge_containers
        SET selected = false, selected_by = $2, selected_at = now(),
            visibility_acknowledged_by = NULL, purge_requested_at = now(),
            gone_at = COALESCE(gone_at, now()), updated_at = now()
      WHERE connector_id = $1
        AND (selected OR purge_requested_at IS NULL OR gone_at IS NULL)`,
    [connectorId, by],
  );
  // With containers still to purge, the people go with the last of them.
  const people = await tx.query(
    `DELETE FROM knowledge_principals p
      WHERE p.connector_id = $1 AND ${NOTHING_REFERS_TO('p.connector_id')}`,
    [connectorId],
  );
  await tx.query('DELETE FROM knowledge_state WHERE key = $1', [lifeKey(connectorId)]);
  return (emptied.rowCount ?? 0) + (marked.rowCount ?? 0) + (people.rowCount ?? 0);
}

async function upsertContainerRow(
  client: SqlClient,
  connectorId: string,
  c: SourceContainer,
): Promise<void> {
  await client.query(
    `INSERT INTO knowledge_containers (id, connector_id, external_id, kind, name, url, visibility, archived, acl)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     ON CONFLICT (connector_id, external_id) DO UPDATE SET
       kind = EXCLUDED.kind, name = EXCLUDED.name, url = EXCLUDED.url, visibility = EXCLUDED.visibility,
       archived = EXCLUDED.archived, acl = COALESCE(EXCLUDED.acl, knowledge_containers.acl),
       -- A row on its way out stays that way: a listing that commits after a
       -- connector was deleted must not undo the delete. The purge removes
       -- the row, and the next listing adds a fresh one.
       gone_at = CASE WHEN knowledge_containers.purge_requested_at IS NOT NULL
                      THEN knowledge_containers.gone_at ELSE NULL END,
       updated_at = now()`,
    [
      randomUUID(),
      connectorId,
      c.externalId,
      c.kind,
      c.name,
      c.url ?? null,
      c.visibility,
      c.archived,
      c.acl ? JSON.stringify(c.acl) : null,
    ],
  );
}

export class KnowledgeStore {
  constructor(private readonly db: Db) {}

  // ── Containers ───────────────────────────────────────────────────────────

  /** A COMPLETE listing from the source: present ones are upserted, the rest marked gone. */
  async upsertContainers(connectorId: string, containers: SourceContainer[]): Promise<void> {
    await this.db.tx(async (tx) => {
      for (const c of containers) await upsertContainerRow(tx, connectorId, c);
      await tx.query(
        `UPDATE knowledge_containers SET gone_at = now(), updated_at = now()
          WHERE connector_id = $1 AND gone_at IS NULL AND NOT (external_id = ANY($2::text[]))`,
        [connectorId, containers.map((c) => c.externalId)],
      );
    });
  }

  /**
   * What the source says about ONE container, asked for on its own. The rest
   * of the list is left as it is: nothing is marked gone on this evidence.
   */
  async upsertContainer(connectorId: string, container: SourceContainer): Promise<void> {
    await upsertContainerRow(this.db, connectorId, container);
  }

  async listContainers(connectorId: string): Promise<ContainerRow[]> {
    const { rows } = await this.db.query<Raw>(
      `SELECT ${CONTAINER_COLUMNS} FROM knowledge_containers WHERE connector_id = $1 ORDER BY name`,
      [connectorId],
    );
    return rows.map(containerRow);
  }

  /** The container a run of `mode` visited longest ago comes first. */
  async selectedContainers(
    connectorId: string,
    mode: KnowledgeRunMode = 'poll',
  ): Promise<SelectedContainer[]> {
    const stamp = mode === 'reconcile' ? 'last_reconciled_at' : 'last_polled_at';
    const { rows } = await this.db.query<Raw>(
      `SELECT ${CONTAINER_COLUMNS} FROM knowledge_containers
        WHERE connector_id = $1 AND selected AND gone_at IS NULL AND purge_requested_at IS NULL
          -- Everything indexed is visible to every signed-in user, so content the
          -- source restricts is fetched only once someone has acknowledged that.
          -- A selected repository that turns private stops here until then.
          AND (visibility = 'open' OR visibility_acknowledged_by IS NOT NULL)
        ORDER BY ${stamp} ASC NULLS FIRST, name`,
      [connectorId],
    );
    return rows.map(containerRow).map(toSelected);
  }

  /** A run of `mode` finished with the container, whether or not it stored anything. */
  async markVisited(
    connectorId: string,
    container: SelectedContainer,
    mode: KnowledgeRunMode,
  ): Promise<void> {
    const stamp = mode === 'reconcile' ? 'last_reconciled_at' : 'last_polled_at';
    await this.db.query(
      `UPDATE knowledge_containers SET ${stamp} = now(), updated_at = now()
        WHERE connector_id = $1 AND external_id = $2`,
      [connectorId, container.externalId],
    );
  }

  async setSelected(
    connectorId: string,
    externalId: string,
    selected: boolean,
    by: string,
  ): Promise<void> {
    await this.db.query(
      `UPDATE knowledge_containers
          SET selected = $3, selected_by = $4, selected_at = now(), updated_at = now()
        WHERE connector_id = $1 AND external_id = $2`,
      [connectorId, externalId, selected, by],
    );
  }

  /** The picker's rows: every container the source still has, with what is stored for it. */
  async containersWithCounts(connectorId: string, search?: string): Promise<ContainerSummary[]> {
    const columns = CONTAINER_COLUMNS.split(',')
      .map((c) => `c.${c.trim()}`)
      .join(', ');
    const live = `d.id IS NOT NULL AND d.deleted_at IS NULL`;
    const { rows } = await this.db.query<Raw>(
      `SELECT ${columns}, c.visibility_acknowledged_by,
              count(*) FILTER (WHERE ${live} AND NOT d.restricted)::int AS documents,
              count(*) FILTER (WHERE ${live} AND d.index_status = 'indexed')::int AS indexed,
              count(*) FILTER (WHERE ${live} AND d.index_status IN ('pending', 'indexing'))::int AS pending,
              count(*) FILTER (WHERE ${live} AND d.index_status = 'failed')::int AS failed,
              count(*) FILTER (WHERE ${live} AND d.restricted)::int AS restricted
         FROM knowledge_containers c
         LEFT JOIN knowledge_documents d ON d.container_id = c.id
        WHERE c.connector_id = $1
          -- A container the source no longer lists stays visible while it is
          -- selected or still holds content, so an admin can deselect it.
          AND (c.gone_at IS NULL OR c.selected
               OR EXISTS (SELECT 1 FROM knowledge_documents x WHERE x.container_id = c.id))
          AND ($2::text IS NULL OR position(lower($2) IN lower(c.name)) > 0)
        GROUP BY c.id
        ORDER BY c.name`,
      [connectorId, search?.trim() || null],
    );
    return rows.map((r) => ({
      ...containerRow(r),
      visibilityAcknowledgedBy: (r.visibility_acknowledged_by as string | null) ?? null,
      documents: Number(r.documents),
      indexed: Number(r.indexed),
      pending: Number(r.pending),
      failed: Number(r.failed),
      restricted: Number(r.restricted),
    }));
  }

  async getContainer(connectorId: string, id: string): Promise<ContainerRow | null> {
    const { rows } = await this.db.query<Raw>(
      `SELECT ${CONTAINER_COLUMNS} FROM knowledge_containers WHERE connector_id = $1 AND id = $2`,
      [connectorId, id],
    );
    return rows[0] ? containerRow(rows[0]) : null;
  }

  /**
   * Deselecting requests a purge (the worker deletes the content); selecting
   * again before it ran cancels it. `acknowledged` records who accepted that a
   * restricted container's content becomes visible to every signed-in user. It
   * is recorded only for a container that is not open at that moment: sent for
   * an open one there is nothing to accept, and it must not count as consent
   * if the container is restricted later.
   *
   * False when nothing was changed: there is no such container, or it was to
   * be selected and the source no longer has it. The caller read the row
   * before it asked, and a listing or a delete of the connector may have
   * landed since.
   */
  async selectContainer(
    connectorId: string,
    id: string,
    input: { selected: boolean; by: string; acknowledged: boolean },
  ): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE knowledge_containers
          SET selected = $3, selected_by = $4, selected_at = now(),
              visibility_acknowledged_by = CASE
                WHEN $3 AND $5 AND visibility <> 'open' THEN $4
                WHEN $3 THEN visibility_acknowledged_by
                ELSE NULL END,
              purge_requested_at = CASE WHEN $3 THEN NULL ELSE now() END,
              updated_at = now()
        WHERE connector_id = $1 AND id = $2
          -- A container that is gone, or on its way out with a deleted
          -- connector, is not selected: there is nothing to index, and it
          -- would cancel the purge of what it holds. It can be deselected.
          AND (NOT $3 OR gone_at IS NULL)`,
      [connectorId, id, input.selected, input.by, input.acknowledged],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * The connector was deleted: nothing of it is to remain. A container that
   * holds no documents is removed here and now. One that does is deselected,
   * marked gone and marked for purging, and the worker deletes what it holds
   * and then the row (rows carry the names of repositories and channels). The
   * connector's people go here when nothing is left for the worker, and with
   * the last purged container otherwise. Returns how many rows were removed
   * or marked, containers and people together: zero means the id held nothing.
   */
  async deselectConnector(connectorId: string, by: string): Promise<number> {
    return this.db.tx((tx) => clearConnector(tx, connectorId, by));
  }

  /**
   * Called before anything is fetched, shown or changed for a connector, with
   * the time the connector was created. Connector ids are chosen by the
   * caller and can be used again, and a connector deleted while this layer
   * was off left its rows behind: when `bornAt` is not the one recorded for
   * the id, whatever the id holds belongs to an earlier connector and is
   * cleared, the way a delete clears it. Returns how many rows that removed
   * or marked (zero for an id that held nothing), and null, with nothing
   * touched, for a connector already known.
   *
   * Null, too, when the id is on record for a LATER connector: the caller is
   * then the earlier one (a request that was slow, a process whose registry
   * is behind), and what the id holds is not its to clear.
   */
  async beginConnectorLife(
    connectorId: string,
    bornAt: string,
    by: string,
  ): Promise<number | null> {
    return this.db.tx(async (tx) => {
      const key = lifeKey(connectorId);
      // Serialises two first calls for the same id.
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
      const known = await tx.query<{ value: unknown }>(
        'SELECT value FROM knowledge_state WHERE key = $1',
        [key],
      );
      const recorded = known.rows[0]?.value;
      if (recorded === bornAt) return null;
      if (typeof recorded === 'string' && Date.parse(recorded) > Date.parse(bornAt)) return null;
      const cleared = await clearConnector(tx, connectorId, by);
      await tx.query(
        `INSERT INTO knowledge_state (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(bornAt)],
      );
      return cleared;
    });
  }

  /** Whether anything of the connector is selected: the reason to hold its people. */
  async hasSelection(connectorId: string): Promise<boolean> {
    const { rows } = await this.db.query<{ selected: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM knowledge_containers
                       WHERE connector_id = $1 AND selected) AS selected`,
      [connectorId],
    );
    return rows[0]?.selected ?? false;
  }

  /**
   * Deletes what deselected containers hold (chunks go by cascade) and resets
   * their sync state, so selecting one again starts a fresh backfill. A
   * container the source no longer has (or whose connector was deleted) loses
   * its row too. A connector left with nothing selected, nothing stored and no
   * purge pending loses its principals as well: names, emails and logins are
   * held only while something refers to them. Handles up to `limit` containers
   * and says how many it handled, so a caller can go on until none are left.
   */
  async purgeBatch(limit = 20): Promise<{ containers: number; documents: number }> {
    return this.db.tx(async (tx) => {
      const { rows } = await tx.query<{ id: string; connector_id: string }>(
        `SELECT id, connector_id FROM knowledge_containers
          WHERE purge_requested_at IS NOT NULL AND NOT selected
          ORDER BY purge_requested_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      if (rows.length === 0) return { containers: 0, documents: 0 };
      const ids = rows.map((r) => r.id);
      const deleted = await tx.query(
        `DELETE FROM knowledge_documents WHERE container_id = ANY($1::uuid[])`,
        [ids],
      );
      await tx.query(
        `UPDATE knowledge_containers
            SET purge_requested_at = NULL, checkpoint = NULL, last_polled_at = NULL,
                last_reconciled_at = NULL, updated_at = now()
          WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      // Purged, deselected and no longer at the source: nothing would ever
      // show or use the row again. If the source lists the container again,
      // the next listing brings it back.
      await tx.query(
        `DELETE FROM knowledge_containers
          WHERE id = ANY($1::uuid[]) AND gone_at IS NOT NULL AND NOT selected`,
        [ids],
      );
      await tx.query(
        `DELETE FROM knowledge_principals p
          WHERE p.connector_id = ANY($1::text[]) AND ${NOTHING_REFERS_TO('p.connector_id')}`,
        [[...new Set(rows.map((r) => r.connector_id))]],
      );
      return { containers: rows.length, documents: deleted.rowCount ?? 0 };
    });
  }

  /** One purge batch; returns the number of documents deleted. */
  async purgeRequested(limit = 20): Promise<number> {
    return (await this.purgeBatch(limit)).documents;
  }

  // ── Principals ───────────────────────────────────────────────────────────

  async upsertPrincipals(connectorId: string, principals: SourcePrincipal[]): Promise<void> {
    if (principals.length === 0) return;
    await this.db.tx((tx) => upsertPrincipalRows(tx, connectorId, principals));
  }

  /**
   * Deletes people nothing refers to: those of a connector that has nothing
   * selected, nothing stored and no purge pending. Returns how many.
   */
  async sweepUnusedPrincipals(): Promise<number> {
    const { rowCount } = await this.db.query(
      `DELETE FROM knowledge_principals p WHERE ${NOTHING_REFERS_TO('p.connector_id')}`,
    );
    return rowCount ?? 0;
  }

  private async principalIds(
    tx: SqlClient,
    connectorId: string,
    externalIds: string[],
  ): Promise<Map<string, string>> {
    if (externalIds.length === 0) return new Map();
    const { rows } = await tx.query<{ external_id: string; id: string }>(
      `SELECT external_id, id FROM knowledge_principals WHERE connector_id = $1 AND external_id = ANY($2::text[])`,
      [connectorId, externalIds],
    );
    return new Map(rows.map((r) => [r.external_id, r.id]));
  }

  // ── Documents: the sink side ─────────────────────────────────────────────

  /**
   * One transaction: upsert documents (pending when their content changed),
   * tombstone deletions, save the checkpoint. `redactions` is keyed by external
   * id; the sink computed it while redacting segments before calling here.
   */
  async storeBatch(
    connectorId: string,
    container: SelectedContainer,
    batch: ChangeBatch,
    redactions: Map<string, number>,
  ): Promise<{ changed: number; deleted: number }> {
    return this.db.tx(async (tx) => {
      // Locked for the whole batch: a deselect, a purge or a reselect waits
      // for it, and it sees theirs.
      const containerRowResult = await tx.query<{
        id: string;
        selected: boolean;
        checkpoint: string | null;
      }>(
        `SELECT id, selected, checkpoint FROM knowledge_containers
          WHERE connector_id = $1 AND external_id = $2
          FOR UPDATE`,
        [connectorId, container.externalId],
      );
      const found = containerRowResult.rows[0];
      const containerId = found?.id;
      // The row is gone: its connector was deleted (or the container purged
      // after the source dropped it) while this run was fetching. Like a
      // deselect, that is the container changing under the run, not a failure.
      if (!found || !containerId) {
        throw new KnowledgeContainerChanged(
          `container ${container.externalId} is not known to connector ${connectorId} any more`,
        );
      }
      // Deselected while this run was fetching: storing more would refill
      // what the purge is about to delete, or has just deleted.
      if (!found.selected) {
        throw new KnowledgeContainerChanged(
          `container ${container.externalId} is not selected any more`,
        );
      }
      // The run holds the checkpoint it read (and then wrote, batch by batch).
      // If the stored one differs, the container was purged and selected again
      // in between: this batch belongs to the old life of the container, and
      // its checkpoint would tell the fresh backfill that everything is stored.
      if ((found.checkpoint ?? null) !== (container.checkpoint ?? null)) {
        throw new KnowledgeContainerChanged(
          `container ${container.externalId} was reset since this run read it`,
        );
      }

      // Only now, with the batch accepted: the people it refers to, before the
      // documents so that their authors resolve. Written ahead of the checks
      // above, a batch refused after its connector was deleted would leave
      // names behind with nothing left to remove them.
      if (batch.principals && batch.principals.length > 0) {
        await upsertPrincipalRows(tx, connectorId, batch.principals);
      }

      const externalIds = batch.documents.map((d) => d.externalId);
      const existing = await tx.query<{ external_id: string; content_hash: string | null }>(
        `SELECT external_id, content_hash FROM knowledge_documents WHERE connector_id = $1 AND external_id = ANY($2::text[])`,
        [connectorId, externalIds],
      );
      const previousHash = new Map(existing.rows.map((r) => [r.external_id, r.content_hash]));

      const allPrincipals = new Set<string>();
      for (const d of batch.documents) {
        if (d.authorExternalId) allPrincipals.add(d.authorExternalId);
        for (const p of d.participantExternalIds) allPrincipals.add(p);
      }
      const principalIds = await this.principalIds(tx, connectorId, [...allPrincipals]);

      let changed = 0;
      for (const d of batch.documents) {
        const hash = d.restricted ? null : contentHashOf(d.title, d.segments);
        const isChanged =
          !previousHash.has(d.externalId) || previousHash.get(d.externalId) !== hash;
        if (isChanged && !d.restricted) changed += 1;
        const participants = d.participantExternalIds
          .map((p) => principalIds.get(p))
          .filter((x): x is string => Boolean(x));
        await tx.query(
          `INSERT INTO knowledge_documents (
             id, connector_id, container_id, external_id, kind, title, url, segments, content_hash,
             source_version, source_created_at, source_updated_at, author_principal_id, participant_principal_ids,
             state, attributes, restricted, acl, redactions, index_status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14::uuid[], $15, $16::jsonb, $17, $18::jsonb, $19, $20)
           ON CONFLICT (connector_id, external_id) DO UPDATE SET
             container_id = EXCLUDED.container_id, kind = EXCLUDED.kind, title = EXCLUDED.title, url = EXCLUDED.url,
             segments = EXCLUDED.segments, content_hash = EXCLUDED.content_hash, source_version = EXCLUDED.source_version,
             source_created_at = EXCLUDED.source_created_at, source_updated_at = EXCLUDED.source_updated_at,
             author_principal_id = EXCLUDED.author_principal_id, participant_principal_ids = EXCLUDED.participant_principal_ids,
             state = EXCLUDED.state, attributes = EXCLUDED.attributes, restricted = EXCLUDED.restricted,
             acl = COALESCE(EXCLUDED.acl, knowledge_documents.acl), redactions = EXCLUDED.redactions,
             -- A stub loses its chunks below, so it must also forget the hash
             -- they were built from: the same content coming back later has
             -- to be indexed again, not waved through as unchanged.
             indexed_hash = CASE WHEN EXCLUDED.restricted THEN NULL ELSE knowledge_documents.indexed_hash END,
             index_version = CASE WHEN EXCLUDED.restricted THEN NULL ELSE knowledge_documents.index_version END,
             index_status = CASE
               WHEN EXCLUDED.restricted THEN 'skipped'
               WHEN knowledge_documents.deleted_at IS NOT NULL
                 OR EXCLUDED.content_hash IS DISTINCT FROM knowledge_documents.content_hash THEN 'pending'
               ELSE knowledge_documents.index_status END,
             -- Only a status move clears the claim stamp. An unchanged re-send
             -- must leave a failed document's backoff anchor and an in-flight
             -- claim's age alone, or neither is ever retried or reclaimed.
             index_claimed_at = CASE
               WHEN EXCLUDED.restricted
                 OR knowledge_documents.deleted_at IS NOT NULL
                 OR EXCLUDED.content_hash IS DISTINCT FROM knowledge_documents.content_hash THEN NULL
               ELSE knowledge_documents.index_claimed_at END,
             index_attempts = CASE
               WHEN EXCLUDED.content_hash IS DISTINCT FROM knowledge_documents.content_hash THEN 0
               ELSE knowledge_documents.index_attempts END,
             deleted_at = NULL, updated_at = now()`,
          [
            randomUUID(),
            connectorId,
            containerId,
            d.externalId,
            d.kind,
            d.title,
            d.url,
            JSON.stringify(d.restricted ? [] : d.segments),
            hash,
            d.sourceVersion,
            d.sourceCreatedAt,
            d.sourceUpdatedAt,
            d.authorExternalId ? (principalIds.get(d.authorExternalId) ?? null) : null,
            participants,
            d.state ?? null,
            JSON.stringify(d.attributes),
            d.restricted,
            d.acl ? JSON.stringify(d.acl) : null,
            redactions.get(d.externalId) ?? 0,
            d.restricted ? 'skipped' : 'pending',
          ],
        );
        if (d.restricted) {
          // A stub never keeps chunks from a time before it became restricted.
          await tx.query(
            `DELETE FROM knowledge_chunks WHERE document_id IN (SELECT id FROM knowledge_documents WHERE connector_id = $1 AND external_id = $2)`,
            [connectorId, d.externalId],
          );
        }
      }

      const deleted = await this.tombstone(tx, connectorId, batch.deletedExternalIds);

      await tx.query(
        `UPDATE knowledge_containers
            SET checkpoint = COALESCE($3, checkpoint),
                -- Only a poll batch (it carries a checkpoint) counts as a poll.
                last_polled_at = CASE WHEN $3::text IS NOT NULL THEN now() ELSE last_polled_at END,
                updated_at = now()
          WHERE connector_id = $1 AND external_id = $2`,
        [connectorId, container.externalId, batch.checkpoint],
      );
      return { changed, deleted };
    });
  }

  private async tombstone(
    tx: SqlClient,
    connectorId: string,
    externalIds: string[],
  ): Promise<number> {
    if (externalIds.length === 0) return 0;
    const { rows } = await tx.query<{ id: string }>(
      `UPDATE knowledge_documents
          SET deleted_at = now(), segments = '[]'::jsonb, title = '', attributes = '{}'::jsonb,
              participant_principal_ids = '{}', author_principal_id = NULL, content_hash = NULL,
              indexed_hash = NULL, index_version = NULL,
              index_status = 'skipped', index_claimed_at = NULL, updated_at = now()
        WHERE connector_id = $1 AND external_id = ANY($2::text[]) AND deleted_at IS NULL
        RETURNING id`,
      [connectorId, externalIds],
    );
    if (rows.length > 0) {
      await tx.query(`DELETE FROM knowledge_chunks WHERE document_id = ANY($1::uuid[])`, [
        rows.map((r) => r.id),
      ]);
    }
    return rows.length;
  }

  async pruneMissing(
    connectorId: string,
    container: SelectedContainer,
    presentIds: string[],
    options: PruneOptions = {},
  ): Promise<number> {
    return this.db.tx(async (tx) => {
      const { rows } = await tx.query<{ external_id: string }>(
        `SELECT d.external_id FROM knowledge_documents d
           JOIN knowledge_containers c ON c.id = d.container_id
          WHERE d.connector_id = $1 AND c.external_id = $2 AND d.deleted_at IS NULL
            AND NOT (d.external_id = ANY($3::text[]))
            AND ($4::timestamptz IS NULL OR d.updated_at < $4::timestamptz)
            AND ($5::text[] IS NULL OR d.kind = ANY($5::text[]))`,
        [
          connectorId,
          container.externalId,
          presentIds,
          options.listedAt ?? null,
          options.kinds ?? null,
        ],
      );
      // An empty listing over a populated container is a fault far more often
      // than a mass delete, so the first one prunes nothing and is only
      // remembered. A second empty listing in a row is believed: a container
      // really emptied at the source must not keep its copies for ever.
      const emptyKey = `empty-listing:${connectorId}:${container.externalId}`;
      if (presentIds.length === 0 && rows.length > 0) {
        const seen = await tx.query(`SELECT 1 FROM knowledge_state WHERE key = $1`, [emptyKey]);
        if (seen.rows.length === 0) {
          await tx.query(
            `INSERT INTO knowledge_state (key, value) VALUES ($1, to_jsonb(now()))
             ON CONFLICT (key) DO NOTHING`,
            [emptyKey],
          );
          return 0;
        }
      }
      await tx.query(`DELETE FROM knowledge_state WHERE key = $1`, [emptyKey]);
      const deleted = await this.tombstone(
        tx,
        connectorId,
        rows.map((r) => r.external_id),
      );
      await tx.query(
        `UPDATE knowledge_containers SET last_reconciled_at = now(), updated_at = now()
          WHERE connector_id = $1 AND external_id = $2`,
        [connectorId, container.externalId],
      );
      return deleted;
    });
  }

  // ── Documents: the worker side ───────────────────────────────────────────

  /**
   * Claims up to `limit` documents for indexing: pending ones, claims older than
   * `staleAfterMs` (a crashed worker), and failed ones whose backoff has passed
   * (4^attempts minutes, at most MAX_INDEX_ATTEMPTS attempts).
   */
  async claimPending(limit: number, staleAfterMs: number = CLAIM_STALE_MS): Promise<DocumentRow[]> {
    const { rows } = await this.db.query<Raw>(
      `UPDATE knowledge_documents SET index_status = 'indexing', index_claimed_at = now()
        WHERE id IN (
          SELECT id FROM knowledge_documents
           WHERE deleted_at IS NULL AND (
                 index_status = 'pending'
              OR (index_status = 'indexing' AND index_claimed_at < now() - ($2::int * interval '1 millisecond'))
              OR (index_status = 'failed' AND index_attempts < $3
                  AND index_claimed_at < now() - (power(4, index_attempts)::int * interval '1 minute')))
           ORDER BY updated_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED)
        RETURNING ${DOCUMENT_COLUMNS}`,
      [limit, staleAfterMs, MAX_INDEX_ATTEMPTS],
    );
    return rows.map(documentRow);
  }

  async getDocument(id: string): Promise<DocumentRow | null> {
    const { rows } = await this.db.query<Raw>(
      `SELECT ${DOCUMENT_COLUMNS} FROM knowledge_documents WHERE id = $1`,
      [id],
    );
    return rows[0] ? documentRow(rows[0]) : null;
  }

  /** text_hash → pgvector literal, for chunks already embedded with this model. */
  async existingChunkEmbeddings(documentId: string, model: string): Promise<Map<string, string>> {
    const { rows } = await this.db.query<{ text_hash: string; embedding: string }>(
      `SELECT text_hash, embedding::text AS embedding FROM knowledge_chunks
        WHERE document_id = $1 AND embedding IS NOT NULL AND embedding_model = $2`,
      [documentId, model],
    );
    return new Map(rows.map((r) => [r.text_hash, r.embedding]));
  }

  /**
   * Writes the chunks and marks the document indexed, but only when the row is
   * still the claim the worker took: `indexing`, same content hash, not deleted,
   * not restricted. The sink may have tombstoned, restricted or edited the
   * document while it was being embedded; then nothing is written and the
   * sink's state stands. Returns false in that case.
   */
  async replaceChunks(
    documentId: string,
    chunks: StoredChunkInput[],
    meta: { indexedHash: string; indexVersion: number },
  ): Promise<boolean> {
    return this.db.tx(async (tx) => {
      const claim = await tx.query<{ id: string }>(
        `SELECT id FROM knowledge_documents
          WHERE id = $1 AND ${STILL_THE_CLAIM}
          FOR UPDATE`,
        [documentId, meta.indexedHash],
      );
      if (claim.rows.length === 0) return false;
      await tx.query(`DELETE FROM knowledge_chunks WHERE document_id = $1`, [documentId]);
      for (const c of chunks) {
        await tx.query(
          `INSERT INTO knowledge_chunks (id, document_id, seq, segment_keys, url, occurred_at, prefix, text, text_hash,
                                         token_estimate, embedding, embedding_model)
           VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8, $9, $10, $11::halfvec, $12)`,
          [
            randomUUID(),
            documentId,
            c.seq,
            c.segmentKeys,
            c.url ?? null,
            c.occurredAt ?? null,
            c.prefix,
            c.text,
            c.textHash,
            c.tokenEstimate,
            c.embedding,
            c.embeddingModel,
          ],
        );
      }
      await tx.query(
        `UPDATE knowledge_documents
            SET index_status = 'indexed', indexed_hash = $2, index_version = $3, index_attempts = 0,
                index_error = NULL, index_claimed_at = NULL, updated_at = now()
          WHERE id = $1`,
        [documentId, meta.indexedHash, meta.indexVersion],
      );
      return true;
    });
  }

  // The three marks below apply only while the row is still `indexing`: once
  // the sink has moved it (tombstone, restriction, edit), the worker's late
  // verdict about the old content must not overwrite the new state.

  async markUnchanged(documentId: string, indexVersion: number): Promise<void> {
    await this.db.query(
      `UPDATE knowledge_documents
          SET index_status = 'indexed', index_version = $2, index_claimed_at = NULL, updated_at = now()
        WHERE id = $1 AND index_status = 'indexing'`,
      [documentId, indexVersion],
    );
  }

  /**
   * Nothing to index (no segments). Chunks left from an earlier version go in
   * the same transaction, or text the source removed would stay searchable.
   */
  async markSkipped(documentId: string): Promise<void> {
    await this.db.tx(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `UPDATE knowledge_documents
            SET index_status = 'skipped', index_claimed_at = NULL, indexed_hash = NULL,
                index_version = NULL, updated_at = now()
          WHERE id = $1 AND index_status = 'indexing'
          RETURNING id`,
        [documentId],
      );
      if (rows.length > 0) {
        await tx.query(`DELETE FROM knowledge_chunks WHERE document_id = $1`, [documentId]);
      }
    });
  }

  /**
   * A claimed document is still being worked on: its claim is renewed, so
   * that a document long enough to outlast the stale window is not handed to a
   * second worker halfway. False when the row is no longer the claim the
   * worker took (the same test `replaceChunks` makes): the sink changed or
   * removed the document, and what is left of the work would be thrown away.
   */
  async keepClaim(documentId: string, contentHash: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      `UPDATE knowledge_documents SET index_claimed_at = now()
        WHERE id = $1 AND ${STILL_THE_CLAIM}`,
      [documentId, contentHash],
    );
    return (rowCount ?? 0) > 0;
  }

  /**
   * Hands a claimed document back, to be claimed again at once. For a worker
   * that is stopping: the document did not fail, so no attempt is counted and
   * no backoff starts. A document that is no longer a claim is left alone.
   */
  async releaseClaim(documentId: string): Promise<void> {
    await this.db.query(
      `UPDATE knowledge_documents SET index_status = 'pending'
        WHERE id = $1 AND index_status = 'indexing'`,
      [documentId],
    );
  }

  async markFailed(documentId: string, error: string): Promise<void> {
    await this.db.query(
      `UPDATE knowledge_documents
          SET index_status = 'failed', index_attempts = index_attempts + 1, index_error = left($2, 2000),
              index_claimed_at = now(), updated_at = now()
        WHERE id = $1 AND index_status = 'indexing'`,
      [documentId, error],
    );
  }

  async countsByIndexStatus(): Promise<Record<string, number>> {
    const { rows } = await this.db.query<{ index_status: string; n: string }>(
      `SELECT index_status, count(*)::text AS n FROM knowledge_documents WHERE deleted_at IS NULL GROUP BY index_status`,
    );
    return Object.fromEntries(rows.map((r) => [r.index_status, Number(r.n)]));
  }

  async deleteTombstonesOlderThan(days: number): Promise<number> {
    const { rowCount } = await this.db.query(
      `DELETE FROM knowledge_documents WHERE deleted_at IS NOT NULL AND deleted_at < now() - ($1::int * interval '1 day')`,
      [days],
    );
    return rowCount ?? 0;
  }

  // ── State ────────────────────────────────────────────────────────────────

  async getState<T>(key: string): Promise<T | null> {
    const { rows } = await this.db.query<{ value: T }>(
      `SELECT value FROM knowledge_state WHERE key = $1`,
      [key],
    );
    return rows[0]?.value ?? null;
  }

  async setState(key: string, value: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO knowledge_state (key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }
}
