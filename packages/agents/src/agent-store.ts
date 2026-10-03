import { randomUUID } from 'node:crypto';
import type { Db } from './db.js';
import type { AgentDefinition } from './definition.js';

export interface AgentRecord {
  id: string;
  slug: string;
  name: string;
  description: string;
  ownerTeamId: string | null;
  enabled: boolean;
  builtin: boolean;
  draftDefinition: AgentDefinition;
  publishedVersion: number | null;
  /** Increments on every write. The API uses it as the ETag. */
  revision: number;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface AgentVersionRecord {
  agentId: string;
  version: number;
  definition: AgentDefinition;
  note: string;
  createdBy: string;
  createdAt: string;
}

export interface CreateAgentInput {
  slug: string;
  name: string;
  description?: string;
  ownerTeamId?: string | null;
  definition: AgentDefinition;
  builtin?: boolean;
  actor: string;
}

export interface UpdateAgentPatch {
  name?: string;
  description?: string;
  ownerTeamId?: string | null;
  enabled?: boolean;
  definition?: AgentDefinition;
}

export interface ListAgentsOptions {
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}

export class AgentNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(id: string) {
    super(`Agent ${id} not found`);
    this.name = 'AgentNotFoundError';
  }
}

export class AgentSlugTakenError extends Error {
  readonly code = 'SLUG_TAKEN';
  constructor(slug: string) {
    super(`An agent with the slug "${slug}" already exists`);
    this.name = 'AgentSlugTakenError';
  }
}

export class AgentVersionConflictError extends Error {
  readonly code = 'VERSION_CONFLICT';
  constructor(
    id: string,
    readonly serverRevision: number,
  ) {
    super(`Agent ${id} was changed by someone else (now at revision ${serverRevision})`);
    this.name = 'AgentVersionConflictError';
  }
}

export class AgentBuiltinProtectedError extends Error {
  readonly code = 'BUILTIN_PROTECTED';
  constructor(id: string) {
    super(`Agent ${id} is built in and cannot be archived`);
    this.name = 'AgentBuiltinProtectedError';
  }
}

interface AgentRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  owner_team_id: string | null;
  enabled: boolean;
  builtin: boolean;
  draft_definition: AgentDefinition;
  published_version: number | null;
  revision: number;
  created_by: string;
  updated_by: string;
  created_at: Date;
  updated_at: Date;
  archived_at: Date | null;
}

interface VersionRow {
  agent_id: string;
  version: number;
  definition: AgentDefinition;
  note: string;
  created_by: string;
  created_at: Date;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAGE = 200;

const iso = (value: Date | string): string => new Date(value).toISOString();

function toRecord(row: AgentRow): AgentRecord {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    ownerTeamId: row.owner_team_id,
    enabled: row.enabled,
    builtin: row.builtin,
    draftDefinition: row.draft_definition,
    publishedVersion: row.published_version,
    revision: row.revision,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    archivedAt: row.archived_at ? iso(row.archived_at) : null,
  };
}

function toVersion(row: VersionRow): AgentVersionRecord {
  return {
    agentId: row.agent_id,
    version: row.version,
    definition: row.definition,
    note: row.note,
    createdBy: row.created_by,
    createdAt: iso(row.created_at),
  };
}

function isUniqueViolation(err: unknown, constraint: string): boolean {
  const e = err as { code?: string; constraint?: string; message?: string };
  return e?.code === '23505' && (e.constraint === constraint || !!e.message?.includes(constraint));
}

/**
 * Postgres-backed store for agent definitions. Every mutation bumps `revision`;
 * passing `expectedRevision` makes the write conditional on it (optimistic
 * concurrency), and `undefined` forces the write, matching the If-Match rule
 * used by the other editable resources.
 */
export class AgentStore {
  constructor(private readonly db: Db) {}

  async create(input: CreateAgentInput): Promise<AgentRecord> {
    try {
      const { rows } = await this.db.query<AgentRow>(
        `INSERT INTO agents
           (id, slug, name, description, owner_team_id, builtin, draft_definition, created_by, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $8)
         RETURNING *`,
        [
          randomUUID(),
          input.slug,
          input.name,
          input.description ?? '',
          input.ownerTeamId ?? null,
          input.builtin ?? false,
          JSON.stringify(input.definition),
          input.actor,
        ],
      );
      return toRecord(rows[0]!);
    } catch (err) {
      if (isUniqueViolation(err, 'agents_slug_live_key')) throw new AgentSlugTakenError(input.slug);
      throw err;
    }
  }

  async get(id: string): Promise<AgentRecord | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<AgentRow>('SELECT * FROM agents WHERE id = $1', [id]);
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async getBySlug(slug: string): Promise<AgentRecord | null> {
    const { rows } = await this.db.query<AgentRow>(
      'SELECT * FROM agents WHERE slug = $1 AND archived_at IS NULL',
      [slug],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  async list(opts: ListAgentsOptions = {}): Promise<{ items: AgentRecord[]; total: number }> {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_PAGE);
    const offset = Math.max(opts.offset ?? 0, 0);
    const includeArchived = opts.includeArchived ?? false;
    const [page, count] = await Promise.all([
      this.db.query<AgentRow>(
        `SELECT * FROM agents
          WHERE ($1::boolean OR archived_at IS NULL)
          ORDER BY updated_at DESC, id
          LIMIT $2 OFFSET $3`,
        [includeArchived, limit, offset],
      ),
      this.db.query<{ total: string }>(
        'SELECT count(*)::text AS total FROM agents WHERE ($1::boolean OR archived_at IS NULL)',
        [includeArchived],
      ),
    ]);
    return { items: page.rows.map(toRecord), total: Number(count.rows[0]!.total) };
  }

  async update(
    id: string,
    expectedRevision: number | undefined,
    patch: UpdateAgentPatch,
    actor: string,
  ): Promise<AgentRecord> {
    if (!UUID.test(id)) throw new AgentNotFoundError(id);
    const params: unknown[] = [id];
    const sets: string[] = [];
    const set = (column: string, value: unknown, cast = '') => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };
    if (patch.name !== undefined) set('name', patch.name);
    if (patch.description !== undefined) set('description', patch.description);
    if (patch.ownerTeamId !== undefined) set('owner_team_id', patch.ownerTeamId);
    if (patch.enabled !== undefined) set('enabled', patch.enabled);
    if (patch.definition !== undefined) {
      set('draft_definition', JSON.stringify(patch.definition), '::jsonb');
    }
    set('updated_by', actor);
    params.push(expectedRevision ?? null);
    const rev = `$${params.length}::integer`;

    const { rows } = await this.db.query<AgentRow>(
      `UPDATE agents
          SET ${sets.join(', ')}, revision = revision + 1, updated_at = now()
        WHERE id = $1 AND archived_at IS NULL AND (${rev} IS NULL OR revision = ${rev})
        RETURNING *`,
      params,
    );
    if (rows[0]) return toRecord(rows[0]);
    throw await this.explainMiss(id, false);
  }

  /** Freezes the current draft as the next immutable version and marks it published. */
  async publish(
    id: string,
    expectedRevision: number | undefined,
    note: string,
    actor: string,
  ): Promise<{ agent: AgentRecord; version: AgentVersionRecord }> {
    if (!UUID.test(id)) throw new AgentNotFoundError(id);
    return this.db.tx(async (client) => {
      const current = await client.query<AgentRow>(
        'SELECT * FROM agents WHERE id = $1 AND archived_at IS NULL FOR UPDATE',
        [id],
      );
      const row = current.rows[0];
      if (!row) throw new AgentNotFoundError(id);
      if (expectedRevision !== undefined && row.revision !== expectedRevision) {
        throw new AgentVersionConflictError(id, row.revision);
      }
      const next = await client.query<{ next: number }>(
        'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM agent_versions WHERE agent_id = $1',
        [id],
      );
      const version = Number(next.rows[0]!.next);
      const inserted = await client.query<VersionRow>(
        `INSERT INTO agent_versions (agent_id, version, definition, note, created_by)
         VALUES ($1, $2, $3::jsonb, $4, $5)
         RETURNING *`,
        [id, version, JSON.stringify(row.draft_definition), note, actor],
      );
      const updated = await client.query<AgentRow>(
        `UPDATE agents
            SET published_version = $2, revision = revision + 1, updated_by = $3, updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [id, version, actor],
      );
      return { agent: toRecord(updated.rows[0]!), version: toVersion(inserted.rows[0]!) };
    });
  }

  /** Soft-deletes. The slug becomes free for a new agent; versions and history stay. */
  async archive(id: string, expectedRevision: number | undefined, actor: string): Promise<void> {
    if (!UUID.test(id)) throw new AgentNotFoundError(id);
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE agents
          SET archived_at = now(), enabled = false, revision = revision + 1,
              updated_by = $2, updated_at = now()
        WHERE id = $1 AND archived_at IS NULL AND builtin = false
          AND ($3::integer IS NULL OR revision = $3::integer)
        RETURNING id`,
      [id, actor, expectedRevision ?? null],
    );
    if (rows[0]) return;
    throw await this.explainMiss(id, true);
  }

  async listVersions(id: string): Promise<AgentVersionRecord[]> {
    if (!UUID.test(id)) return [];
    const { rows } = await this.db.query<VersionRow>(
      'SELECT * FROM agent_versions WHERE agent_id = $1 ORDER BY version DESC',
      [id],
    );
    return rows.map(toVersion);
  }

  async getVersion(id: string, version: number): Promise<AgentVersionRecord | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<VersionRow>(
      'SELECT * FROM agent_versions WHERE agent_id = $1 AND version = $2',
      [id, version],
    );
    return rows[0] ? toVersion(rows[0]) : null;
  }

  // A conditional write matched no row. Work out why, so the caller can tell
  // "gone" from "protected" from "someone else got there first".
  private async explainMiss(id: string, archiving: boolean): Promise<Error> {
    const { rows } = await this.db.query<{
      revision: number;
      builtin: boolean;
      archived_at: Date | null;
    }>('SELECT revision, builtin, archived_at FROM agents WHERE id = $1', [id]);
    const row = rows[0];
    if (!row || row.archived_at) return new AgentNotFoundError(id);
    if (archiving && row.builtin) return new AgentBuiltinProtectedError(id);
    return new AgentVersionConflictError(id, row.revision);
  }
}
