import { randomUUID } from 'node:crypto';
import type { Db, SqlClient } from './db.js';
import type { AgentDefinition, GrantPolicy, ToolEffect } from './definition.js';

export const RUN_STATUSES = [
  'queued',
  'running',
  'waiting_approval',
  'waiting_input',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);

export type RunMode = 'task' | 'chat';
export type RunWritePolicy = 'as_granted' | 'always_ask';
export type RunTriggerKind =
  'manual' | 'api' | 'schedule' | 'webhook' | 'event' | 'run_completed' | 'workflow' | 'agent_tool';

export type RunErrorCode =
  | 'BUDGET_EXCEEDED'
  | 'STEP_LIMIT'
  | 'TIMEOUT'
  | 'CONTEXT_EXCEEDED'
  | 'MODEL_REFUSED'
  | 'MODEL_ERROR'
  | 'DAILY_LIMIT'
  | 'INTERNAL';

export interface RunError {
  code: RunErrorCode;
  message: string;
}

export interface RunRecord {
  id: string;
  agentId: string;
  /** The pinned published version; null for a draft run. */
  agentVersion: number | null;
  definition: AgentDefinition;
  parentRunId: string | null;
  rootRunId: string;
  depth: number;
  triggerKind: RunTriggerKind;
  triggeredBy: string;
  mode: RunMode;
  writePolicy: RunWritePolicy;
  status: RunStatus;
  input: unknown;
  output: unknown;
  error: RunError | null;
  inputTokens: number;
  outputTokens: number;
  steps: number;
  cancelRequested: boolean;
  warnings: string[];
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
}

/** One stored message: the whole model-layer message object, provider metadata included. */
export interface StoredMessage {
  role: 'user' | 'assistant' | 'tool';
  [key: string]: unknown;
}

export interface RunMessageRecord {
  runId: string;
  seq: number;
  role: StoredMessage['role'];
  content: StoredMessage;
  createdAt: string;
}

export type ToolCallStatus =
  'pending' | 'executing' | 'succeeded' | 'failed' | 'denied' | 'expired' | 'outcome_unknown';

export interface ToolCallRecord {
  id: string;
  runId: string;
  callId: string;
  messageSeq: number;
  toolId: string;
  /** Null for a call to a tool that does not exist. */
  service: string | null;
  effect: ToolEffect | null;
  policy: GrantPolicy;
  decision: 'allow' | 'ask' | 'deny';
  status: ToolCallStatus;
  input: unknown;
  output: unknown;
  outputTruncated: boolean;
  error: unknown;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface CreateRunInput {
  agentId: string;
  agentVersion: number | null;
  definition: AgentDefinition;
  triggerKind: RunTriggerKind;
  triggeredBy: string;
  mode: RunMode;
  writePolicy?: RunWritePolicy;
  input: unknown;
  /** The opening messages, usually one user message. */
  messages: StoredMessage[];
  parentRunId?: string | null;
}

export interface StartToolCallInput {
  runId: string;
  callId: string;
  messageSeq: number;
  toolId: string;
  service: string | null;
  effect: ToolEffect | null;
  policy: GrantPolicy;
  decision: 'allow' | 'ask' | 'deny';
  status: ToolCallStatus;
  input: unknown;
  /** Set when the call is decided without running (denied, invalid input). */
  error?: unknown;
}

export interface ListRunsOptions {
  agentId?: string;
  status?: RunStatus;
  limit?: number;
  offset?: number;
}

export class RunNotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(id: string) {
    super(`Run ${id} not found`);
    this.name = 'RunNotFoundError';
  }
}

/** The worker lost the run to another worker (its lease ran out and was taken). */
export class RunLeaseLostError extends Error {
  readonly code = 'RUN_LEASE_LOST';
  constructor(id: string) {
    super(`Run ${id} is held by another worker`);
    this.name = 'RunLeaseLostError';
  }
}

export class RunNotWaitingError extends Error {
  readonly code = 'RUN_NOT_WAITING';
  constructor(
    id: string,
    readonly status: RunStatus,
  ) {
    super(`Run ${id} is ${status}, not waiting for a message`);
    this.name = 'RunNotWaitingError';
  }
}

interface RunRow {
  id: string;
  agent_id: string;
  agent_version: number | null;
  definition: AgentDefinition;
  parent_run_id: string | null;
  root_run_id: string;
  depth: number;
  trigger_kind: RunTriggerKind;
  triggered_by: string;
  mode: RunMode;
  write_policy: RunWritePolicy;
  status: RunStatus;
  input: unknown;
  output: unknown;
  error: RunError | null;
  input_tokens: number;
  output_tokens: number;
  steps: number;
  cancel_requested: boolean;
  warnings: string[];
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  updated_at: Date;
}

interface MessageRow {
  run_id: string;
  seq: number;
  role: StoredMessage['role'];
  content: StoredMessage;
  created_at: Date;
}

interface ToolCallRow {
  id: string;
  run_id: string;
  call_id: string;
  message_seq: number;
  tool_id: string;
  service: string | null;
  effect: ToolEffect | null;
  policy: GrantPolicy;
  decision: 'allow' | 'ask' | 'deny';
  status: ToolCallStatus;
  input: unknown;
  output: unknown;
  output_truncated: boolean;
  error: unknown;
  started_at: Date | null;
  finished_at: Date | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_PAGE = 200;
// Statuses a run can leave by being cancelled without a worker's help.
const PARKED = "('queued', 'waiting_input', 'waiting_approval')";
const LIVE = "('queued', 'running', 'waiting_input', 'waiting_approval')";

const iso = (value: Date | string): string => new Date(value).toISOString();
const isoOrNull = (value: Date | null): string | null => (value ? iso(value) : null);
const json = (value: unknown): string => JSON.stringify(value ?? null);

function toRun(row: RunRow): RunRecord {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentVersion: row.agent_version,
    definition: row.definition,
    parentRunId: row.parent_run_id,
    rootRunId: row.root_run_id,
    depth: row.depth,
    triggerKind: row.trigger_kind,
    triggeredBy: row.triggered_by,
    mode: row.mode,
    writePolicy: row.write_policy,
    status: row.status,
    input: row.input,
    output: row.output,
    error: row.error,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    steps: row.steps,
    cancelRequested: row.cancel_requested,
    warnings: row.warnings,
    createdAt: iso(row.created_at),
    startedAt: isoOrNull(row.started_at),
    finishedAt: isoOrNull(row.finished_at),
    updatedAt: iso(row.updated_at),
  };
}

function toMessage(row: MessageRow): RunMessageRecord {
  return {
    runId: row.run_id,
    seq: row.seq,
    role: row.role,
    content: row.content,
    createdAt: iso(row.created_at),
  };
}

function toToolCall(row: ToolCallRow): ToolCallRecord {
  return {
    id: row.id,
    runId: row.run_id,
    callId: row.call_id,
    messageSeq: row.message_seq,
    toolId: row.tool_id,
    service: row.service,
    effect: row.effect,
    policy: row.policy,
    decision: row.decision,
    status: row.status,
    input: row.input,
    output: row.output,
    outputTruncated: row.output_truncated,
    error: row.error,
    startedAt: isoOrNull(row.started_at),
    finishedAt: isoOrNull(row.finished_at),
  };
}

async function insertMessages(
  client: SqlClient,
  runId: string,
  firstSeq: number,
  messages: StoredMessage[],
): Promise<RunMessageRecord[]> {
  const out: RunMessageRecord[] = [];
  for (const [i, message] of messages.entries()) {
    const { rows } = await client.query<MessageRow>(
      `INSERT INTO run_messages (run_id, seq, role, content)
       VALUES ($1, $2, $3, $4::jsonb)
       RETURNING *`,
      [runId, firstSeq + i, message.role, json(message)],
    );
    out.push(toMessage(rows[0]!));
  }
  return out;
}

/**
 * Postgres-backed store for agent runs. The runner is the only writer of a
 * running run: it claims the run with a lease, renews the lease while it works,
 * and gives it up when the run parks or ends. The API creates runs, adds chat
 * messages and requests cancels; each of those is a single conditional write,
 * so the two sides never overwrite each other.
 */
export class RunStore {
  constructor(private readonly db: Db) {}

  async create(input: CreateRunInput): Promise<RunRecord> {
    const id: string = randomUUID();
    return this.db.tx(async (client) => {
      let rootRunId = id;
      let depth = 0;
      if (input.parentRunId) {
        const parent = await client.query<{ root_run_id: string; depth: number }>(
          'SELECT root_run_id, depth FROM runs WHERE id = $1',
          [input.parentRunId],
        );
        if (!parent.rows[0]) throw new RunNotFoundError(input.parentRunId);
        rootRunId = parent.rows[0].root_run_id;
        depth = parent.rows[0].depth + 1;
      }
      const { rows } = await client.query<RunRow>(
        `INSERT INTO runs (id, agent_id, agent_version, definition, parent_run_id, root_run_id,
                           depth, trigger_kind, triggered_by, mode, write_policy, input)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
         RETURNING *`,
        [
          id,
          input.agentId,
          input.agentVersion,
          json(input.definition),
          input.parentRunId ?? null,
          rootRunId,
          depth,
          input.triggerKind,
          input.triggeredBy,
          input.mode,
          input.writePolicy ?? 'as_granted',
          json(input.input),
        ],
      );
      await insertMessages(client, id, 0, input.messages);
      return toRun(rows[0]!);
    });
  }

  async get(id: string): Promise<RunRecord | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<RunRow>('SELECT * FROM runs WHERE id = $1', [id]);
    return rows[0] ? toRun(rows[0]) : null;
  }

  async list(opts: ListRunsOptions = {}): Promise<{ items: RunRecord[]; total: number }> {
    if (opts.agentId !== undefined && !UUID.test(opts.agentId)) return { items: [], total: 0 };
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), MAX_PAGE);
    const offset = Math.max(opts.offset ?? 0, 0);
    const where = `($1::uuid IS NULL OR agent_id = $1::uuid) AND ($2::text IS NULL OR status = $2::text)`;
    const filters = [opts.agentId ?? null, opts.status ?? null];
    const [page, count] = await Promise.all([
      this.db.query<RunRow>(
        `SELECT * FROM runs WHERE ${where} ORDER BY created_at DESC, id LIMIT $3 OFFSET $4`,
        [...filters, limit, offset],
      ),
      this.db.query<{ total: string }>(
        `SELECT count(*)::text AS total FROM runs WHERE ${where}`,
        filters,
      ),
    ]);
    return { items: page.rows.map(toRun), total: Number(count.rows[0]!.total) };
  }

  /**
   * Takes the run for one worker. Succeeds for a queued run, or for a running
   * run whose previous holder's lease ran out (that worker died). Returns null
   * when someone else holds it, it was cancelled, or it is finished.
   */
  async claim(id: string, owner: string, leaseSeconds: number): Promise<RunRecord | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<RunRow>(
      `UPDATE runs
          SET status = 'running', lease_owner = $2,
              lease_expires_at = now() + make_interval(secs => $3),
              started_at = COALESCE(started_at, now()),
              -- Taking over a dead worker's run is not progress: leaving
              -- updated_at alone lets failStalled stop a run that keeps
              -- killing its workers.
              updated_at = CASE WHEN status = 'queued' THEN now() ELSE updated_at END
        WHERE id = $1 AND NOT cancel_requested
          AND (status = 'queued' OR (status = 'running' AND lease_expires_at < now()))
        RETURNING *`,
      [id, owner, leaseSeconds],
    );
    return rows[0] ? toRun(rows[0]) : null;
  }

  /** Extends the holder's lease. `held: false` means another worker took the run. */
  async renewLease(
    id: string,
    owner: string,
    leaseSeconds: number,
  ): Promise<{ held: boolean; cancelRequested: boolean }> {
    const { rows } = await this.db.query<{ cancel_requested: boolean }>(
      `UPDATE runs SET lease_expires_at = now() + make_interval(secs => $3)
        WHERE id = $1 AND lease_owner = $2 AND status = 'running'
        RETURNING cancel_requested`,
      [id, owner, leaseSeconds],
    );
    return rows[0]
      ? { held: true, cancelRequested: rows[0].cancel_requested }
      : { held: false, cancelRequested: false };
  }

  /**
   * Running runs whose worker stopped renewing. The runner re-queues them.
   * Runs with a cancel request are left out: claim() refuses them, so
   * cancelAbandoned() finishes them instead.
   */
  async expiredLeases(): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      `SELECT id FROM runs
        WHERE status = 'running' AND lease_expires_at < now() AND NOT cancel_requested
        ORDER BY id`,
    );
    return rows.map((r) => r.id);
  }

  /**
   * Finishes, as cancelled, running runs that were asked to stop and whose
   * worker died before it could. Nothing else can: no worker may claim them.
   */
  async cancelAbandoned(): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE runs
          SET status = 'cancelled', finished_at = now(), updated_at = now(),
              lease_owner = NULL, lease_expires_at = NULL
        WHERE status = 'running' AND cancel_requested AND lease_expires_at < now()
        RETURNING id`,
    );
    return rows.map((r) => r.id).sort();
  }

  /**
   * Queued runs no worker has picked up for `olderThanSeconds`: their job was
   * lost (Redis restarted, or a worker failed before claiming). The caller
   * queues them again. Each is returned once per window, also across runner
   * replicas, because returning it restarts its wait.
   */
  async requeueStaleQueued(olderThanSeconds: number): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE runs SET updated_at = now()
        WHERE status = 'queued' AND updated_at < now() - make_interval(secs => $1)
        RETURNING id`,
      [olderThanSeconds],
    );
    return rows.map((r) => r.id).sort();
  }

  /**
   * Appends to the transcript. With `owner`, only the worker holding the lease
   * may append; anyone else gets RunLeaseLostError and nothing is written.
   */
  async appendMessages(
    id: string,
    messages: StoredMessage[],
    owner?: string,
  ): Promise<RunMessageRecord[]> {
    return this.db.tx(async (client) => {
      // Locking the run row serialises appends, so sequence numbers never collide.
      const run = await client.query<{ lease_owner: string | null }>(
        'SELECT lease_owner FROM runs WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (!run.rows[0]) throw new RunNotFoundError(id);
      if (owner !== undefined && run.rows[0].lease_owner !== owner) {
        throw new RunLeaseLostError(id);
      }
      const next = await client.query<{ next: number }>(
        'SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM run_messages WHERE run_id = $1',
        [id],
      );
      const out = await insertMessages(client, id, Number(next.rows[0]!.next), messages);
      await client.query('UPDATE runs SET updated_at = now() WHERE id = $1', [id]);
      return out;
    });
  }

  async listMessages(id: string, opts: { afterSeq?: number } = {}): Promise<RunMessageRecord[]> {
    if (!UUID.test(id)) return [];
    const { rows } = await this.db.query<MessageRow>(
      'SELECT * FROM run_messages WHERE run_id = $1 AND seq > $2 ORDER BY seq',
      [id, opts.afterSeq ?? -1],
    );
    return rows.map(toMessage);
  }

  /** Counts one model step and adds its token usage. */
  /**
   * Counts one model step: on the run, and on the agent's usage for today
   * (UTC), which is what the daily cap reads.
   */
  async recordStep(id: string, usage: { input: number; output: number }): Promise<RunRecord> {
    return this.db.tx(async (client) => {
      const { rows } = await client.query<RunRow>(
        `UPDATE runs
            SET steps = steps + 1, input_tokens = input_tokens + $2,
                output_tokens = output_tokens + $3, updated_at = now()
          WHERE id = $1
          RETURNING *`,
        [id, usage.input, usage.output],
      );
      if (!rows[0]) throw new RunNotFoundError(id);
      await client.query(
        `INSERT INTO agent_usage_daily (agent_id, day, input_tokens, output_tokens)
         VALUES ($1, (now() AT TIME ZONE 'UTC')::date, $2, $3)
         ON CONFLICT (agent_id, day) DO UPDATE
           SET input_tokens = agent_usage_daily.input_tokens + EXCLUDED.input_tokens,
               output_tokens = agent_usage_daily.output_tokens + EXCLUDED.output_tokens`,
        [rows[0].agent_id, usage.input, usage.output],
      );
      return toRun(rows[0]);
    });
  }

  /**
   * Records a warning once. Adding one the run already has changes nothing,
   * `updated_at` included: the run loop adds a run's warnings again after
   * every takeover, and that must not look like progress to failStalled.
   */
  async addWarning(id: string, warning: string): Promise<RunRecord> {
    const { rows } = await this.db.query<RunRow>(
      `UPDATE runs
          SET warnings = CASE WHEN warnings @> $2::jsonb THEN warnings ELSE warnings || $2::jsonb END,
              updated_at = CASE WHEN warnings @> $2::jsonb THEN updated_at ELSE now() END
        WHERE id = $1
        RETURNING *`,
      [id, json([warning])],
    );
    if (!rows[0]) throw new RunNotFoundError(id);
    return toRun(rows[0]);
  }

  /**
   * Moves a live run to a terminal status and releases its lease. Returns null
   * when the run had already ended: the first outcome stands. With `owner`, a
   * worker that lost the lease gets RunLeaseLostError instead.
   */
  async finish(
    id: string,
    outcome:
      | { status: 'succeeded'; output: unknown }
      | { status: 'failed'; error: RunError; output?: unknown }
      | { status: 'cancelled'; output?: unknown },
    owner?: string,
  ): Promise<RunRecord | null> {
    const { rows } = await this.db.query<RunRow>(
      `UPDATE runs
          SET status = $2, output = $3::jsonb, error = $4::jsonb, finished_at = now(),
              updated_at = now(), lease_owner = NULL, lease_expires_at = NULL
        WHERE id = $1 AND status IN ${LIVE} AND ($5::text IS NULL OR lease_owner = $5::text)
        RETURNING *`,
      [
        id,
        outcome.status,
        json('output' in outcome ? outcome.output : null),
        json(outcome.status === 'failed' ? outcome.error : null),
        owner ?? null,
      ],
    );
    if (rows[0]) return toRun(rows[0]);
    await this.throwIfHeldByOther(id, owner);
    return null;
  }

  /**
   * Ends a chat turn: the run waits for the next message and holds no worker.
   * A cancel requested while the worker held the run is settled here instead:
   * the run ends cancelled. Parked with the request still pending it could
   * never be claimed again, and its next message would leave it queued for good.
   */
  async waitForInput(id: string, owner?: string): Promise<RunRecord | null> {
    const { rows } = await this.db.query<RunRow>(
      `UPDATE runs
          SET status = CASE WHEN cancel_requested THEN 'cancelled' ELSE 'waiting_input' END,
              finished_at = CASE WHEN cancel_requested THEN now() ELSE finished_at END,
              updated_at = now(), lease_owner = NULL, lease_expires_at = NULL
        WHERE id = $1 AND status = 'running' AND ($2::text IS NULL OR lease_owner = $2::text)
        RETURNING *`,
      [id, owner ?? null],
    );
    if (rows[0]) return toRun(rows[0]);
    await this.throwIfHeldByOther(id, owner);
    return null;
  }

  // A conditional write by `owner` matched nothing: if the run is still live
  // and someone else holds it, say so rather than reporting a quiet no-op.
  private async throwIfHeldByOther(id: string, owner: string | undefined): Promise<void> {
    if (owner === undefined) return;
    const { rows } = await this.db.query<{ status: RunStatus; lease_owner: string | null }>(
      'SELECT status, lease_owner FROM runs WHERE id = $1',
      [id],
    );
    const row = rows[0];
    if (row && !TERMINAL_RUN_STATUSES.has(row.status) && row.lease_owner !== owner) {
      throw new RunLeaseLostError(id);
    }
  }

  /** Adds the next chat message to a run that is waiting for one and re-queues it. */
  async addUserMessage(id: string, message: StoredMessage): Promise<RunRecord> {
    if (!UUID.test(id)) throw new RunNotFoundError(id);
    return this.db.tx(async (client) => {
      const current = await client.query<RunRow>('SELECT * FROM runs WHERE id = $1 FOR UPDATE', [
        id,
      ]);
      const row = current.rows[0];
      if (!row) throw new RunNotFoundError(id);
      if (row.status !== 'waiting_input') throw new RunNotWaitingError(id, row.status);
      const next = await client.query<{ next: number }>(
        'SELECT COALESCE(MAX(seq), -1) + 1 AS next FROM run_messages WHERE run_id = $1',
        [id],
      );
      await insertMessages(client, id, Number(next.rows[0]!.next), [message]);
      const updated = await client.query<RunRow>(
        `UPDATE runs SET status = 'queued', updated_at = now() WHERE id = $1 RETURNING *`,
        [id],
      );
      return toRun(updated.rows[0]!);
    });
  }

  /**
   * Asks a run to stop. A run no worker holds (queued, or parked waiting) is
   * cancelled at once; a running run is flagged and its worker stops at the next
   * check. A finished run is returned unchanged. Null when the run does not exist.
   */
  async requestCancel(id: string): Promise<RunRecord | null> {
    if (!UUID.test(id)) return null;
    const { rows } = await this.db.query<RunRow>(
      `UPDATE runs
          SET cancel_requested = true,
              status = CASE WHEN status IN ${PARKED} THEN 'cancelled' ELSE status END,
              finished_at = CASE WHEN status IN ${PARKED} THEN now() ELSE finished_at END,
              updated_at = now()
        WHERE id = $1 AND status IN ${LIVE}
        RETURNING *`,
      [id],
    );
    if (rows[0]) return toRun(rows[0]);
    return this.get(id);
  }

  /**
   * Writes the audit row for a tool call before it runs. With `owner`, only
   * the worker holding the run's lease may start a call.
   *
   * A call that already has a row is started again in two cases only: it was
   * recorded as `pending` and has not run yet, or it is a read that was in
   * flight when its worker died. A write or delete in flight is never started
   * again (whoever wrote that row ran it, or may have), and neither is a call
   * that already has an outcome: the first outcome stands.
   *
   * Every refusal is RunLeaseLostError and writes nothing. The loop reads a
   * step's calls before it settles them, so it only meets a row it did not
   * expect when another worker is settling the same step.
   */
  async startToolCall(input: StartToolCallInput, owner?: string): Promise<ToolCallRecord> {
    const { rows } = await this.db.query<ToolCallRow>(
      `INSERT INTO tool_calls (id, run_id, call_id, message_seq, tool_id, service, effect, policy,
                               decision, status, input, error, started_at, finished_at)
       SELECT $1::uuid, $2::uuid, $3::text, $4::integer, $5::text, $6::text, $7::text, $8::text,
              $9::text, $10::text, $11::jsonb, $12::jsonb, now(),
              CASE WHEN $10::text = 'executing' THEN NULL ELSE now() END
        WHERE $13::text IS NULL
           OR EXISTS (SELECT 1 FROM runs WHERE id = $2::uuid AND lease_owner = $13::text)
       ON CONFLICT (run_id, call_id) DO UPDATE
          SET status = EXCLUDED.status, started_at = now(), finished_at = EXCLUDED.finished_at,
              error = EXCLUDED.error
        WHERE tool_calls.status = 'pending'
           OR (tool_calls.status = 'executing' AND tool_calls.effect = 'read')
       RETURNING *`,
      [
        randomUUID(),
        input.runId,
        input.callId,
        input.messageSeq,
        input.toolId,
        input.service,
        input.effect,
        input.policy,
        input.decision,
        input.status,
        json(input.input),
        input.error === undefined ? null : json(input.error),
        owner ?? null,
      ],
    );
    if (!rows[0]) throw new RunLeaseLostError(input.runId);
    return toToolCall(rows[0]);
  }

  /**
   * Records how a call ended. The first outcome stands: a call that is no
   * longer in flight is returned as stored, so a worker that lost the run and
   * finishes late cannot overwrite what the new holder recorded.
   */
  async finishToolCall(
    id: string,
    result: {
      status: Exclude<ToolCallStatus, 'pending' | 'executing'>;
      output?: unknown;
      outputTruncated?: boolean;
      error?: unknown;
    },
  ): Promise<ToolCallRecord> {
    const { rows } = await this.db.query<ToolCallRow>(
      `UPDATE tool_calls
          SET status = $2, output = $3::jsonb, output_truncated = $4, error = $5::jsonb,
              finished_at = now()
        WHERE id = $1 AND status IN ('pending', 'executing')
        RETURNING *`,
      [
        id,
        result.status,
        result.output === undefined ? null : json(result.output),
        result.outputTruncated ?? false,
        result.error === undefined ? null : json(result.error),
      ],
    );
    if (rows[0]) return toToolCall(rows[0]);
    const stored = await this.db.query<ToolCallRow>('SELECT * FROM tool_calls WHERE id = $1', [id]);
    if (!stored.rows[0]) throw new Error(`Tool call ${id} not found`);
    return toToolCall(stored.rows[0]);
  }

  async listToolCalls(runId: string): Promise<ToolCallRecord[]> {
    if (!UUID.test(runId)) return [];
    const { rows } = await this.db.query<ToolCallRow>(
      'SELECT * FROM tool_calls WHERE run_id = $1 ORDER BY message_seq, started_at, call_id',
      [runId],
    );
    return rows.map(toToolCall);
  }

  /**
   * Input plus output tokens the agent spent on the UTC day `day` falls on,
   * whenever the runs that spent them began.
   */
  async tokensOnDay(agentId: string, day: Date): Promise<number> {
    const { rows } = await this.db.query<{ total: string }>(
      `SELECT COALESCE(SUM(input_tokens + output_tokens), 0)::text AS total
         FROM agent_usage_daily WHERE agent_id = $1 AND day = $2::date`,
      [agentId, day.toISOString().slice(0, 10)],
    );
    return Number(rows[0]!.total);
  }

  /**
   * Fails running runs that made no progress for twice their timeout: the last
   * line of defence when a run keeps getting taken over and dying.
   */
  async failStalled(): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE runs
          SET status = 'failed', finished_at = now(), updated_at = now(),
              lease_owner = NULL, lease_expires_at = NULL,
              error = jsonb_build_object('code', 'INTERNAL',
                                         'message', 'The run made no progress and was stopped.')
        WHERE status = 'running'
          AND updated_at < now() - make_interval(
                secs => 2 * (definition -> 'limits' ->> 'timeoutSeconds')::integer)
        RETURNING id`,
    );
    return rows.map((r) => r.id).sort();
  }

  /** Closes chat runs nobody has written to for `idleMinutes`. */
  async closeIdleChats(idleMinutes: number): Promise<string[]> {
    const { rows } = await this.db.query<{ id: string }>(
      `UPDATE runs
          SET status = 'succeeded', finished_at = now(), updated_at = now()
        WHERE status = 'waiting_input' AND mode = 'chat'
          AND updated_at < now() - make_interval(mins => $1)
        RETURNING id`,
      [idleMinutes],
    );
    return rows.map((r) => r.id).sort();
  }
}
