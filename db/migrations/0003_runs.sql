-- 0003_runs.sql: agent runs, their transcripts, and the tool calls they make.
--
-- Applied by the migration step, never by the app at boot. Forward-only.

CREATE TABLE runs (
  id                uuid PRIMARY KEY,
  agent_id          uuid NOT NULL REFERENCES agents (id),
  -- The published version the run pins; NULL for a draft run from the test panel.
  agent_version     integer,
  -- The definition the run executes, copied at creation so an edit or a new
  -- version never changes a run in flight.
  definition        jsonb NOT NULL,
  parent_run_id     uuid REFERENCES runs (id),
  root_run_id       uuid NOT NULL,
  depth             integer NOT NULL DEFAULT 0,
  trigger_kind      text NOT NULL,
  trigger_id        uuid,
  triggered_by      text NOT NULL,
  -- 'chat' runs end each turn waiting for the next message; 'task' runs end.
  mode              text NOT NULL,
  write_policy      text NOT NULL DEFAULT 'as_granted',
  status            text NOT NULL DEFAULT 'queued',
  input             jsonb NOT NULL,
  output            jsonb,
  error             jsonb,
  input_tokens      integer NOT NULL DEFAULT 0,
  output_tokens     integer NOT NULL DEFAULT 0,
  steps             integer NOT NULL DEFAULT 0,
  cancel_requested  boolean NOT NULL DEFAULT false,
  -- The worker holding the run renews this lease while it works. A run whose
  -- lease ran out (its worker died) can be claimed again and resumed.
  lease_owner       text,
  lease_expires_at  timestamptz,
  warnings          jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz,
  -- Bumped on every write; the stall sweeper compares it with the timeout.
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runs_trigger_kind_valid CHECK (trigger_kind IN
    ('manual', 'api', 'schedule', 'webhook', 'event', 'run_completed', 'workflow', 'agent_tool')),
  CONSTRAINT runs_mode_valid CHECK (mode IN ('task', 'chat')),
  CONSTRAINT runs_write_policy_valid CHECK (write_policy IN ('as_granted', 'always_ask')),
  CONSTRAINT runs_status_valid CHECK (status IN
    ('queued', 'running', 'waiting_approval', 'waiting_input', 'succeeded', 'failed', 'cancelled')),
  CONSTRAINT runs_depth_nonnegative CHECK (depth >= 0)
);

CREATE INDEX runs_status_idx ON runs (status);
CREATE INDEX runs_agent_created_idx ON runs (agent_id, created_at DESC);
CREATE INDEX runs_created_idx ON runs (created_at DESC);
-- No index on root_run_id or parent_run_id yet: nothing reads a run's tree.
-- The migration that adds child runs or run retention adds them.

-- The transcript exactly as the model layer consumes it (each row is one
-- message object, provider metadata included). Append-only.
CREATE TABLE run_messages (
  run_id     uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  seq        integer NOT NULL,
  role       text NOT NULL,
  content    jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, seq),
  CONSTRAINT run_messages_role_valid CHECK (role IN ('user', 'assistant', 'tool')),
  CONSTRAINT run_messages_seq_nonnegative CHECK (seq >= 0)
);

CREATE TABLE tool_calls (
  id               uuid PRIMARY KEY,
  run_id           uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  -- The model's id for the call; unique within a run.
  call_id          text NOT NULL,
  -- seq of the assistant message that asked for the call.
  message_seq      integer NOT NULL,
  -- For a call to a tool that does not exist, tool_id is the name the model
  -- used and service and effect are NULL.
  tool_id          text NOT NULL,
  service          text,
  effect           text,
  policy           text NOT NULL,
  decision         text NOT NULL,
  status           text NOT NULL,
  input            jsonb NOT NULL,
  input_hash       text,
  output           jsonb,
  output_truncated boolean NOT NULL DEFAULT false,
  error            jsonb,
  approval_id      uuid,
  started_at       timestamptz,
  finished_at      timestamptz,
  CONSTRAINT tool_calls_run_call_key UNIQUE (run_id, call_id),
  CONSTRAINT tool_calls_effect_valid CHECK (effect IS NULL OR effect IN ('read', 'write', 'delete')),
  CONSTRAINT tool_calls_policy_valid CHECK (policy IN ('off', 'allow', 'ask')),
  CONSTRAINT tool_calls_decision_valid CHECK (decision IN ('allow', 'ask', 'deny')),
  CONSTRAINT tool_calls_status_valid CHECK (status IN
    ('pending', 'executing', 'succeeded', 'failed', 'denied', 'expired', 'outcome_unknown'))
);

-- Calls are read by run, which the unique (run_id, call_id) index serves. An
-- index by service and effect arrives with the first query that filters on them.
