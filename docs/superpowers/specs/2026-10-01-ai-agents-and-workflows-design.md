# AI agents and workflows v1 — design

**Date:** 2026-10-01
**Status:** Draft for review (design), pending implementation plans
**Scope:** one design for the whole first release. It fixes the architecture and the
contracts between parts. Implementation is planned per milestone (§Milestones); each
milestone gets its own plan under `docs/superpowers/plans/`. The workflow canvas gets a
short UI spec of its own when its milestone is planned, the way the Connector Hub did.
**Lineage:** deep dive in `docs/agent/plans/ai-agents-and-workflows.md`; owner decisions
in `docs/agent/decisions/agent-platform-v1-foundations.md`.

## Problem

ShipIt-AI builds a knowledge graph and exposes it to _other people's_ agents through an
MCP server. It runs no agent of its own. Nothing server-side calls a model: `/ask` is a
hard-coded mock, `/admin/agent-activity` is a placeholder, and no LLM SDK is in any
`package.json`. Users who want an agent that watches pull requests, answers ownership
questions on a schedule, or opens a fix have to build and host it elsewhere, wire it to
our MCP endpoint, and get no permission model, no audit trail and no approvals from us.

Three structural gaps stand between today and that feature, and this design closes them
because agents cannot be correct without them:

1. **No store for definitions or run history.** Editable config lives in YAML (lost on pod
   restart in GKE), one 64KB GSM blob, Redis and Neo4j. Run transcripts fit none of them.
2. **No way to act.** All 8 MCP tools read. The connector interface is ingest-only, the
   GitHub App is read-only, the Kubernetes role is `get, list, watch`.
3. **No event fan-out.** The event bus is one BullMQ work queue with one consumer. The
   webhook receiver acts on `push` and `workflow_run` and drops everything else.

## Goal

An admin opens **AI → Agents**, defines an agent (instructions, model, tools, per-service
read / write / delete access), tests it in a side panel, and attaches triggers. The agent
then runs on a schedule, on an API call, on an inbound webhook, on a graph or GitHub
event, or when another agent finishes. It reads the graph, edits the graph, reads GitHub
repositories, and opens pull requests, with every write either pre-approved by its grants
or held for a person. Several agents can be composed into a workflow on a canvas with
branches, parallel steps, approval gates and bounded loops. Every model turn, tool call
and approval is recorded and visible under **AI → Activity**.

## Non-goals

- **Kubernetes write actions.** The Kubernetes connector stays read-only. Agents reach
  cluster facts through the graph.
- **A code sandbox.** No shell, no checkout, no test execution. Agents change repositories
  only through the GitHub API (read file, commit files to a branch, open a pull request).
- **Merging pull requests, pushing to default or protected branches, editing workflow
  files.** Not offered as tools. The actions App is not granted the `workflows` permission.
- **OAuth for external MCP servers.** v1 connects with no auth, a static bearer token or a
  custom header. Servers that require an OAuth flow are out.
- **Models outside Vertex AI, and Mistral on Vertex.** Mistral is served through a
  different endpoint shape (`rawPredict`) that the chosen provider package does not cover.
- **Conversation compaction.** A run that outgrows the model's context fails with
  `CONTEXT_EXCEEDED`. Tool results are truncated before they enter context.
- **Per-team ownership and custom roles.** Agent administration follows the two existing
  roles. Real RBAC is `ClaudePlans/01`.
- **Multi-replica runner.** `agent-runner` runs at `replicas: 1`. The design does not
  prevent more; it is not exercised or tested in v1.
- **Triggers from the actions App's own webhook** (for example an `@mention` in an issue
  comment). GitHub events come from the existing connector App receiver only.
- **Claude Managed Agents as a runtime.** A seam is kept (§Runner); no implementation.
- **MCP tool-call telemetry for external clients** (the original Agent Activity scope,
  `ClaudePlans/02` #8). Activity covers runs of our own agents. External MCP call logging
  can join the same page later.

## Decisions

| #   | Decision                                                                                                                              | Rationale                                                                                                                                                   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Postgres** for definitions, runs, transcripts, approvals. Infra repo creates the instance and applies schema. _(owner, 2026-10-01)_ | Already the planned next persistence step; transcripts fit nowhere else.                                                                                    |
| 2   | **Migration SQL lives in this repo** (`db/migrations/`), applied by infra at deploy, never by the app at boot.                        | Local dev, CI and self-hosters need the same schema; the infra repo is private.                                                                             |
| 3   | **Our own agent loop** in a new `agent-runner` process. _(owner, 2026-10-01)_                                                         | Keeps grants, approvals and credentials in our code; follows the core-writer precedent; keeps long work out of api-server.                                  |
| 4   | **Vertex AI for any model it offers**, through the AI SDK's Vertex provider. _(owner, 2026-10-01)_                                    | One interface for Gemini, Claude and open models; Workload Identity, no API keys.                                                                           |
| 5   | **We call the model one step at a time** and run tools ourselves. The SDK's own tool loop is not used.                                | The grant check, the approval pause and the audit record must sit between "model asks" and "tool runs".                                                     |
| 6   | **Everything ships in one release.** _(owner, 2026-10-01)_                                                                            | The owner wants the end-to-end feature set working before release. Milestones are build order, not release order.                                           |
| 7   | **Write and delete tools in v1:** graph edits, external MCP servers, GitHub. Kubernetes stays read-only. _(owner, 2026-10-01)_        | Graph and MCP need nothing new. GitHub covers the highest-value action (open a PR). Cluster writes are the highest-risk grant.                              |
| 8   | **GitHub writes use a separate "actions" App**, not broader permissions on the connector App.                                         | The connector stays provably read-only; no existing installation has to re-approve; org admins opt in per repository; revocation is independent.            |
| 9   | **Our own workflow engine**, event-driven, state in Postgres, jobs on BullMQ. _(owner accepted default, 2026-10-01)_                  | No new infrastructure or framework dependency. The definition format is engine-neutral so LangGraph.js can replace the executor later.                      |
| 10  | **Admins create and edit agents; each agent is its own principal.** _(owner accepted default, 2026-10-01)_                            | Two roles exist today. A per-agent principal makes every action attributable.                                                                               |
| 11  | **`pg` with hand-written SQL repositories**, no ORM.                                                                                  | Infra-applied SQL is the schema's source of truth; an ORM schema file would be a second one. Fewer dependencies to patch. An integration test guards drift. |
| 12  | **Permissions are enforced by a tool gateway**, never by the prompt.                                                                  | A model can be talked out of an instruction. It cannot call a tool the gateway did not expose or run a call the gateway did not allow.                      |
| 13  | **Write tools are at-most-once.** A write whose outcome is unknown after a crash is reported to the model as unknown, never re-run.   | Exactly-once is not achievable across a process crash and an external API. Repeating a write silently is worse than surfacing the doubt.                    |
| 14  | **Delete-effect tools can be `off` or `ask`, never `allow`.**                                                                         | No unattended deletes in v1. Cheap to relax later, expensive to regret.                                                                                     |
| 15  | **Agent-authored graph claims use a new `agent` source**, ranked just below `manual`.                                                 | A person's override must always beat an agent's. Agent edits stay distinguishable in the Claim Explorer.                                                    |
| 16  | **Tool-connection secrets are encrypted in Postgres** under one platform key delivered by infra.                                      | The GSM blob pattern is capped at 64KB and its containers are Terraform-managed, so per-connection secrets cannot be created at runtime.                    |
| 17  | **Form-first agent editor; canvas only for workflows.**                                                                               | A single agent has no graph to draw. `GraphEditorCanvas` is reused for workflows.                                                                           |

## Terms

- **Agent** — a named, versioned definition: instructions, model, limits, tool grants.
- **Tool** — one callable capability with a `service` and an `effect` (`read`, `write`,
  `delete`).
- **Grant** — an agent's policy for a service-and-effect or a single tool: `off`, `allow`
  or `ask`.
- **Run** — one execution of an agent or a workflow.
- **Trigger** — a rule that starts a run.
- **Workflow** — a versioned graph of nodes (agents, conditions, approvals) and edges.
- **Connection** — a configured source of tools outside the built-ins: an external MCP
  server or the GitHub actions App for one org.

## Architecture & data flow

```text
            web-ui  /ai/*                          trigger sources
   Agents · Workflows · Activity · Ask · Tools     schedule · webhook · GitHub event
                 |                                 graph event · connector event · API
                 v                                              |
   ┌──────────────────────── api-server ────────────────────────┴───────────┐
   │ /api/agents  /api/workflows  /api/triggers  /api/runs  /api/approvals    │
   │ /api/tools   /api/tool-connections   SSE /api/runs/:id/stream            │
   │ stores definitions, creates run rows, enqueues {runId}; never calls a    │
   │ model. Also the target of graph-write tools (existing manual-edit routes)│
   └───────┬──────────────────────────────┬───────────────────────────────────┘
           | SQL                          | BullMQ {runId} / Redis pub-sub
           v                              v
     ┌──────────┐                 ┌─────────────────── agent-runner ──────────────────┐
     │ Postgres │<── steps ───────│ run worker ──> agent loop ──> model client (Vertex)│
     │          │                 │                    |                               │
     │ agents   │                 │                    v                               │
     │ runs     │                 │              tool gateway: grant check, approval   │
     │ messages │                 │              pause, credentials, audit record      │
     │ tool     │                 │                    |                               │
     │  calls   │                 │   graph read    graph write    GitHub    external  │
     │ approvals│                 │   (Neo4j, in-   (HTTP to       actions   MCP       │
     │ triggers │                 │    process)      api-server)   App       servers   │
     │ workflows│                 │                                                    │
     └──────────┘                 │ trigger scheduler · event router · workflow engine │
                                  └────────────────────────────────────────────────────┘
```

The api-server is the control plane: it owns definitions and decisions (start, cancel,
approve). The runner is the data plane: it owns everything that takes time or spends
money. They share Postgres and Redis and nothing else in memory.

## Packages and processes

| Package                     | Kind    | Contents                                                                                                                                                                                               |
| --------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/agents`           | library | `@shipit-ai/agents`. Zod schemas (agent, trigger, workflow definitions), Postgres repositories, built-in tool catalog (metadata only), grant resolution, run-token and credential crypto, queue names. |
| `packages/agent-runner`     | process | `@shipit-ai/agent-runner`. `src/main.ts` boots like `core-writer/src/main.ts`. Run worker, agent loop, model client, tool executors, trigger scheduler, event router, workflow engine.                 |
| `packages/mcp-server`       | changed | Each tool's handler moves from an inline closure in `server.tool(...)` to an exported function (`runBlastRadius(neo4j, params)`). Registration calls it. New `./tools` export for the runner.          |
| `packages/api-server`       | changed | New route plugins and services listed in §API. `require-auth` gains the run-token resolver. Webhook receiver, sync scheduler and manual-edit services gain small hooks (§Triggers, §Tool sources).     |
| `packages/core-writer`      | changed | Publishes graph-change events when enabled (§Triggers).                                                                                                                                                |
| `packages/shared`           | changed | Config schema `ai` section, `AuthProvider` gains `'agent'`, source-reliability registry gains `agent`, event types for the trigger queue.                                                              |
| `packages/web-ui`           | changed | The AI section (§Web UI).                                                                                                                                                                              |
| `db/migrations/`            | new     | Plain SQL, `NNNN_description.sql`. `scripts/db-migrate.ts` applies them locally and in CI under the same contract infra uses.                                                                          |
| `docker/docker-compose.yml` | changed | Adds `postgres`, a one-shot `migrate` service, and `agent-runner`.                                                                                                                                     |

Per the scar `docker-builder-copies-fixed-package-set`, every new workspace dependency is
added in three places that must agree: the Dockerfile `COPY` list, the package's vitest
alias list, and the lockfile. `agent-runner` gets its own Dockerfile and a CI docker-build
matrix entry.

## Data model

All ids are UUIDs generated by the app. All timestamps are `timestamptz`. JSON columns are
`jsonb`. Each mutable definition table carries an integer `revision` that increments on
update and is the ETag (`If-Match: "<revision>"`), per the editable-config concurrency
decision.

| Table                | Purpose and key columns                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents`             | `id`, `slug` (unique), `name`, `description`, `owner_team_id` (graph canonical id, nullable), `enabled`, `builtin`, `published_version` (nullable), `revision`, `created_by`, `created_at`, `updated_at`, `archived_at`.                                                                                                                                                                                                            |
| `agent_versions`     | `agent_id`, `version` (int, PK with `agent_id`), `definition` (§Agent definition), `note`, `created_by`, `created_at`. Immutable. A run pins `(agent_id, version)`.                                                                                                                                                                                                                                                                 |
| `tool_connections`   | `id`, `kind` (`mcp` \| `github_app`), `slug` (unique; becomes the service name), `name`, `config`, `secret_enc` (bytea, nullable), `status` (`ok` \| `error` \| `unverified`), `status_detail`, `revision`, audit columns.                                                                                                                                                                                                          |
| `connection_tools`   | `connection_id`, `tool_name` (PK with `connection_id`), `description`, `input_schema`, `effect`, `effect_source` (`hint` \| `admin` \| `default`), `enabled`, `discovered_at`.                                                                                                                                                                                                                                                      |
| `triggers`           | `id`, `target_kind` (`agent` \| `workflow`), `target_id`, `kind` (`schedule` \| `webhook` \| `event` \| `run_completed`), `config`, `input_template`, `write_policy` (`as_granted` \| `always_ask`), `enabled`, `secret_enc` (webhook kind), `revision`, audit columns.                                                                                                                                                             |
| `trigger_firings`    | `trigger_id`, `dedupe_key` (PK with `trigger_id`), `run_id` (nullable when dropped), `outcome` (`started` \| `rate_limited` \| `loop_blocked` \| `duplicate`), `fired_at`.                                                                                                                                                                                                                                                          |
| `runs`               | `id`, `kind` (`agent` \| `workflow`), `agent_id` + `agent_version` or `workflow_id` + `workflow_version`, `parent_run_id`, `root_run_id`, `depth`, `workflow_node_id`, `trigger_id`, `trigger_kind` (`manual` \| `api` \| `schedule` \| `webhook` \| `event` \| `run_completed` \| `workflow` \| `agent_tool`), `triggered_by`, `write_policy`, `status`, `input`, `output`, `error`, token totals, `cancel_requested`, timestamps. |
| `run_messages`       | `run_id`, `seq` (PK with `run_id`), `role`, `content`. The transcript exactly as the model layer consumes it, append-only.                                                                                                                                                                                                                                                                                                          |
| `tool_calls`         | `id`, `run_id`, `call_id` (the model's id; unique with `run_id`), `message_seq`, `tool_id`, `service`, `effect`, `policy`, `decision` (`allow` \| `ask` \| `deny`), `status` (`pending` \| `executing` \| `succeeded` \| `failed` \| `denied` \| `expired` \| `outcome_unknown`), `input`, `input_hash`, `output`, `output_truncated`, `error`, `approval_id`, `started_at`, `finished_at`.                                         |
| `approvals`          | `id`, `run_id`, `tool_call_id` (nullable; null for a workflow approval node), `workflow_node_id` (nullable), `summary`, `status` (`pending` \| `approved` \| `denied` \| `expired`), `input_hash`, `requested_at`, `expires_at`, `decided_by`, `decided_at`, `reason`.                                                                                                                                                              |
| `workflows`          | Same shape as `agents` without `builtin`.                                                                                                                                                                                                                                                                                                                                                                                           |
| `workflow_versions`  | `workflow_id`, `version`, `definition` (§Workflows), `note`, audit columns. Immutable.                                                                                                                                                                                                                                                                                                                                              |
| `workflow_node_runs` | `run_id`, `node_id`, `visit` (PK with the other two), `status` (`pending` \| `running` \| `waiting_approval` \| `succeeded` \| `failed` \| `skipped`), `input`, `output`, `child_run_id`, `approval_id`, `error`, timestamps.                                                                                                                                                                                                       |
| `schema_migrations`  | Owned by the migration step: `version`, `applied_at`.                                                                                                                                                                                                                                                                                                                                                                               |

Indexes follow the queries the UI and the limits need: `runs (status)`, `runs (agent_id,
created_at desc)`, `runs (root_run_id)`, `tool_calls (run_id)`, `tool_calls (service,
effect, started_at)`, `approvals (status, requested_at)`, `triggers (kind, enabled)`.

**Retention.** A daily job in the runner deletes `run_messages` and `tool_calls` input and
output bodies for runs finished more than `ai.retention.transcriptDays` ago (default 30),
keeping the run row and the tool-call metadata. Run rows are deleted after
`ai.retention.runDays` (default 180).

**Schema version handshake.** `@shipit-ai/agents` exports `EXPECTED_SCHEMA_VERSION` (the
highest migration prefix it was built against). At boot, api-server and the runner read
`max(version)` from `schema_migrations`. Older than expected, or no `DATABASE_URL`: agent
features are disabled with a clear status (§Feature gating); nothing crashes.

## Agent definition

`agent_versions.definition`, validated by a Zod schema in `@shipit-ai/agents`:

```jsonc
{
  "instructions": "…system prompt…",
  "model": "claude-sonnet", // key into ai.models
  "effort": "medium", // optional; passed through where the provider supports it
  "limits": {
    "maxSteps": 25, // model turns per run
    "maxTokens": 400000, // input + output, per run
    "timeoutSeconds": 900,
    "dailyTokens": 4000000, // per agent, all runs, UTC day
  },
  "grants": {
    "services": {
      "graph": { "read": "allow", "write": "ask", "delete": "off" },
      "github": { "read": "allow", "write": "ask", "delete": "off" },
    },
    "tools": { "github.open_pull_request": "ask", "agent.triage": "allow" },
  },
  "output": { "schema": null }, // optional JSON Schema; see Structured output
}
```

Saving an agent creates a draft revision on `agents`; **Publish** writes a new immutable
`agent_versions` row and sets `published_version`. Triggers and workflows run the
published version unless they pin one. The test panel runs the draft.

**Structured output.** When `output.schema` is set, the runner adds a synthetic tool
`submit_result` whose parameters are that schema and instructs the model to finish by
calling it. The run's `output` is `{ text, data }`, with `data` validated against the
schema. This works on every provider that supports tool calling and does not depend on
native structured output, which Claude on Vertex does not offer through this provider.

## Model layer

Packages: `ai` (AI SDK 7) and `@ai-sdk/google-vertex`. Both are Apache-2.0, ESM-only and
need Node 22, which matches this repo. Authentication is Application Default Credentials:
Workload Identity on GKE, `gcloud auth application-default login` locally.

`ai.models` in config is the catalog the editor's picker shows:

```yaml
ai:
  vertex: { project: '${GOOGLE_CLOUD_PROJECT}', location: global }
  models:
    - key: claude-sonnet
      label: Claude Sonnet
      family: anthropic # anthropic | gemini | maas
      modelId: claude-sonnet-5-5 # the id Vertex expects for that family
      contextWindow: 1000000
      tools: true
```

`family` selects the provider entry point: the package root for Gemini, `/anthropic` for
Claude, `/maas` for open models on the OpenAI-compatible endpoint. A model with
`tools: false` can only back an agent that holds no grants. The seed list is set at
implementation time from the models enabled in the project's Model Garden; it is config,
not code.

The runner wraps the SDK behind one interface so nothing else imports it:

```ts
interface ModelClient {
  step(req: {
    model: ModelRef;
    instructions: string;
    messages: ModelMessage[];
    tools: ToolSpec[]; // name, description, JSON Schema; no executors
    effort?: string;
    signal: AbortSignal;
    onDelta?: (d: TextDelta) => void;
  }): Promise<{
    message: ModelMessage; // assistant content incl. reasoning parts and tool calls
    toolCalls: { callId: string; name: string; input: unknown }[];
    finish: 'stop' | 'tool_calls' | 'length' | 'refusal' | 'error';
    usage: { input: number; output: number; cacheRead?: number; reasoning?: number };
  }>;
}
```

One `step` is one model call. Tools are declared without executors, so the SDK returns the
calls and stops.

Provider differences the layer absorbs:

- **Tool names.** Internal ids use a dot (`graph.blast_radius`). Models see
  `graph__blast_radius`, because provider name rules reject dots. The mapping is the
  gateway's.
- **Tool parameter schemas.** Gemini accepts a subset of JSON Schema. Built-in tool
  schemas are written inside that subset (no unions, no records). External MCP tool
  schemas are passed through; a schema a provider rejects surfaces as a model error naming
  the tool, and the connection page flags it.
- **Signed reasoning.** Claude thinking blocks and Gemini thought signatures must be sent
  back unchanged. `run_messages.content` stores the SDK's message objects as they are,
  including provider metadata, and the runner never edits a stored message. Gemini also
  requires all calls of a step to be followed by all results in order; the loop appends
  results only when every call of the step is resolved (§Run lifecycle).
- **Uneven tool calling on open models.** `tools: false` in the catalog is the guard.

**Not yet proven live.** These facts come from the SDK source and vendor docs read on
2026-10-01; nothing was run against the project. Milestone 1 starts with a spike that
proves three things on Vertex: a single step with tools and no executors on Claude and on
Gemini; a transcript with signed reasoning written to Postgres, read back and accepted by
both; and Workload Identity auth from a pod. If the JSON round-trip fails, the fallback is
the direct SDKs (`@anthropic-ai/vertex-sdk`, `@google/genai`) behind the same
`ModelClient` interface; nothing outside the model layer changes.

## Run lifecycle

Statuses: `queued`, `running`, `waiting_approval`, `waiting_input`, `succeeded`, `failed`,
`cancelled`. `failed` carries `error.code`: `BUDGET_EXCEEDED`, `STEP_LIMIT`, `TIMEOUT`,
`CONTEXT_EXCEEDED`, `MODEL_REFUSED`, `MODEL_ERROR`, `DAILY_LIMIT`, `INTERNAL`.

```text
create run row (queued) ──> enqueue {runId} on shipit-agent-runs
worker picks job:
  load run, pinned agent version, messages, tool_calls
  resolve tools from grants (§Tool gateway)
  settle any tool_calls left 'executing' by a crash   (reads: re-run; writes: outcome_unknown)
  loop:
    check cancel, limits, daily cap
    step = model.step(...)            -> append assistant message, add usage
    no tool calls  -> finish (succeeded, or waiting_input for a chat run)
    for each tool call: gateway.decide()
        deny  -> tool_calls row 'denied'
        allow -> execute (reads in parallel, writes one at a time)
        ask   -> tool_calls row 'pending' + approvals row
    any call pending -> set waiting_approval, release the job
    else append all tool results in call order, continue
```

- **Jobs carry only `{ runId }`.** State lives in Postgres. A job that ends at
  `waiting_approval` or `waiting_input` holds no worker.
- **Resume.** A decision on an approval, or a new user message, enqueues `{ runId }`
  again. The worker reloads and continues: approved calls execute, denied and expired
  calls get an error result, then the step's results are appended together.
- **Crash recovery.** BullMQ redelivers a stalled job. On load, a `tool_calls` row still
  `executing` is settled by effect: a read is re-run; a write or delete is set to
  `outcome_unknown` and the model is told the outcome is unknown and must be verified
  before retrying (decision 13).
- **Limits.** Checked before every model step. The token limit counts input plus output
  across the run. The daily cap sums the agent's runs for the UTC day. Hitting a limit
  fails the run with the matching code; a child run's usage counts toward its own agent.
- **Tool result size.** A result over `ai.limits.toolResultChars` (default 50,000) is
  stored in full and truncated in context with a note saying so.
- **Cancel.** `POST /api/runs/:id/cancel` sets `cancel_requested`; the worker aborts the
  in-flight model call through the `AbortSignal` and stops before the next step. Pending
  approvals of a cancelled run expire.
- **Chat runs.** A run started from Ask or the test panel ends each turn at
  `waiting_input` and resumes on the next message. It closes after
  `ai.limits.chatIdleMinutes` (default 60).
- **Streaming.** The runner publishes `{ runId, seq }` on Redis pub/sub channel
  `shipit-run-events` after each write, and text deltas on `shipit-run-deltas~<runId>`.
  `GET /api/runs/:id/stream` (SSE) relays both; on reconnect the client sends the last
  `seq` and the server replays from Postgres. Deltas are display-only and never stored.
- **Queue hygiene.** Queue names and job ids contain no colon. Every Queue, Worker and
  Redis client has an `error` listener. `attempts: 1`; resume is ours, not BullMQ's.
  Completed and failed job retention is bounded like the existing queues.
- **Runtime seam.** The worker depends on an `AgentRuntime` interface
  (`start(run)`, `resume(run)`, `cancel(run)`); the loop above is its only implementation.

## Tool gateway

Every tool, whatever its source, is described the same way:

```ts
interface ToolDescriptor {
  id: string; // 'graph.blast_radius', 'github.open_pull_request', 'slack.post_message'
  service: string; // 'graph', 'github', '<connection slug>', 'agents'
  effect: 'read' | 'write' | 'delete';
  description: string;
  inputSchema: JsonSchema;
  source: 'builtin' | 'connection' | 'agent';
}
```

**Resolving a grant.** For tool `t`: `grants.tools[t.id]` if present, else
`grants.services[t.service][t.effect]`, else `off`. Then the ceilings apply, each of which
can only tighten:

1. Effect `delete` with policy `allow` becomes `ask`.
2. A run whose `write_policy` is `always_ask` turns `allow` into `ask` for `write` and
   `delete`. Webhook and event triggers default to `always_ask` because their input is
   untrusted; schedules and manual runs default to `as_granted`. A child run inherits the
   stricter of its parent's policy and its own, and a run started by `run_completed`
   inherits the source run's policy the same way.
3. A connection tool whose `effect_source` is not `admin` (nobody confirmed its effect) is
   treated as `write` + `ask`, whatever the server's hint says.
4. A disabled connection or tool resolves to `off`.

Tools that resolve to `off` are not sent to the model at all.

**At save time**, the API rejects a definition that grants a (service, effect) the saving
user's own capabilities do not cover. In v1 only admins save agents, so this always
passes; the check exists so that widening who may create agents cannot widen what agents
may do.

**Deciding a call.** `allow` executes. `ask` creates an approval. A call to a tool not in
the resolved set (a model inventing a name) is `deny` with no approval.

**Approvals.** An approval shows the agent, the tool, its service and effect, the full
input and a link to the run. It binds to `input_hash`: approving runs exactly that input.
A person with `approvals:decide` (admins, plus the agent's creator) decides. Undecided
approvals expire after `ai.approvals.ttlHours` (default 24); the model receives "approval
expired" as the tool result and continues. A denial may carry a reason, which the model
receives.

**Execution context.** The executor receives the run, the agent principal and the
resolved connection. Credentials are fetched inside the executor and never appear in a
message. Each execution writes its `tool_calls` row before it starts (`executing`) and
after it ends, so the audit record exists even if the process dies mid-call.

## Tool sources

### Graph, read — service `graph`

The 8 existing tools: `blast_radius`, `entity_detail`, `schema_info`, `find_owners`,
`dependency_chain`, `graph_stats`, `search_entities`, `graph_query`. The runner imports
the handlers extracted from `mcp-server` and calls them with its own read-only Neo4j
session, `compact: true`. `metadata.ts` gains `service` and `effect` per tool (all
`graph` / `read`). `graph_query` keeps its write-keyword block and row limit. External
MCP clients see no behaviour change.

### Graph, write — service `graph`

| Tool                    | Effect | Maps to                                           |
| ----------------------- | ------ | ------------------------------------------------- |
| `graph.set_property`    | write  | `ManualEditService.setManualClaim` via its route  |
| `graph.revert_property` | write  | `ManualEditService.revertManualClaim` (own claim) |
| `graph.add_relation`    | write  | `RelationEditService.addRelation`                 |
| `graph.remove_relation` | delete | `RelationEditService.deleteRelation`              |

The runner calls the existing api-server routes over HTTP, so the capability gate, the
kill-switch (`accessControl.manualWrite.enabled`), the rate limit and the `GraphEditEvent`
audit all apply unchanged. It authenticates with a **run token**:
`Authorization: Bearer shipit_run_<runId>.<mac>`, where `mac` is an HMAC over the run id
under a subkey of the platform key (§Secrets). `require-auth` verifies the MAC, loads the
run, requires status `running`, and builds a principal
`{ id: 'agent:<agentId>', provider: 'agent', role: 'member', capabilities: ['graph:read', 'graph:write'] }`.

Claims written by an agent principal use source `agent:<agentId>` instead of
`manual:<actor>`. `agent` joins `SOURCE_PRIORITY_ORDER` directly after `manual` with its
own reliability entry, so a person's manual or verified claim always wins over an agent's,
and an agent's wins over connectors. The two services take the source prefix from the
principal's provider. The Claim Explorer labels the source as an agent.

### GitHub — service `github`

A second GitHub App per org, the **actions App**, created from AI → Tools with the
existing manifest flow and a second manifest:
`contents: write`, `pull_requests: write`, `issues: write`, `metadata: read`; no events;
no webhook. The org admin installs it on the repositories agents may touch. That
installation list is the hard ceiling: a repository without the actions App is invisible
to every `github.*` tool. App id, installation id and PEM are stored as a `github_app`
connection, the PEM encrypted.

| Tool                         | Effect | Notes                                                                                                     |
| ---------------------------- | ------ | --------------------------------------------------------------------------------------------------------- |
| `github.get_file`            | read   | File content at a ref; size-capped.                                                                       |
| `github.list_directory`      | read   |                                                                                                           |
| `github.search_code`         | read   | Scoped to installed repositories.                                                                         |
| `github.get_pull_request`    | read   | Metadata, diff stat, changed files.                                                                       |
| `github.list_pull_requests`  | read   |                                                                                                           |
| `github.get_issue`           | read   | With comments.                                                                                            |
| `github.create_branch`       | write  | Name is forced under `shipit/`.                                                                           |
| `github.commit_files`        | write  | One commit of several file changes (add, update, remove) to a `shipit/` branch, through the Git Data API. |
| `github.open_pull_request`   | write  | Head must be a `shipit/` branch. Body carries a footer naming the agent and linking the run.              |
| `github.update_pull_request` | write  | Title and body of a PR the agent platform opened.                                                         |
| `github.comment`             | write  | On an issue or pull request.                                                                              |
| `github.create_issue`        | write  |                                                                                                           |
| `github.add_labels`          | write  |                                                                                                           |
| `github.delete_branch`       | delete | Only `shipit/` branches.                                                                                  |

Guardrails are in the executors, not the prompt: a ref outside `shipit/` is rejected
before any API call; there is no merge tool; paths under `.github/workflows/` are
rejected (GitHub would refuse them anyway without the `workflows` permission). Each call
mints an installation token scoped to the one repository and the permissions that tool
needs.

### External MCP servers — service `<connection slug>`

An admin adds a connection: name, slug, URL (Streamable HTTP), auth (`none`, `bearer`,
`header`). **Test** connects and lists tools into `connection_tools`. Each tool's effect is
pre-filled from the server's annotations (`readOnlyHint` → `read`, `destructiveHint` →
`delete`, otherwise `write`) with `effect_source: 'hint'`; a tool with no annotations
gets `effect_source: 'default'`. The admin confirms or changes each one, which sets
`effect_source: 'admin'`. Hints come from the server and are not trusted: until an admin
confirms a tool, ceiling 3 treats it as `write` + `ask`. The page offers "confirm all as
suggested" for servers the admin trusts.

Re-discovery is manual. New tools arrive disabled. A tool that disappears is marked
disabled and agents holding a grant for it show a warning.

The runner opens one client per connection per run, on first use. Outbound URL rules
apply at save and at connect (§Safety).

### Other agents — service `agents`

`agent.<slug>` runs another agent as a child run and returns its output. Its effect is
`write` if the callee's published version grants any `write` or `delete`, else `read`.
The callee runs under its own grants; the caller needs an explicit tool grant for it.
`depth` is capped at `ai.limits.maxDepth` (default 3). An agent already present in the
chain from `root_run_id` cannot be called again; the call returns an error result.

## Triggers

| Kind            | Config                                                            | Starts when                                                                 |
| --------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| manual          | none; no row                                                      | A user presses Run or sends a message in Ask or the test panel.             |
| api             | none; no row                                                      | `POST /api/agents/:id/runs` with a session or a token holding `agents:run`. |
| `schedule`      | `cron`, `timezone`                                                | A BullMQ Job Scheduler fires.                                               |
| `webhook`       | generated URL and secret                                          | `POST /api/triggers/:id/webhook` passes HMAC verification.                  |
| `event`         | `source`, `type`, `filter`                                        | The event router matches an event.                                          |
| `run_completed` | `sourceKind`, `sourceId`, `on` (`succeeded` \| `failed` \| `any`) | A run of the source agent or workflow finishes. This is "run B after A".    |

`input_template` builds the run input from the trigger payload with `{{ }}` paths
(§Workflows, Templates). For `run_completed` the default is the source run's output.
Trigger payloads enter the run as user content marked as external data.

**Schedules.** The runner owns a queue `shipit-agent-schedules`. It reconciles Job
Schedulers (`upsertJobScheduler`, id `trigger~<id>`) with enabled `schedule` triggers at
boot, on a `shipit-triggers-changed` pub/sub message from api-server, and every 60
seconds. New scheduling code uses Job Schedulers, which exist in the pinned BullMQ 5 and
survive the move to BullMQ 6; the legacy repeatable jobs in `sync-scheduler.ts` are not
touched here.

**Inbound webhooks.** The path is public and verify-first, like the GitHub receiver:
`X-ShipIt-Signature: sha256=<hmac of raw body>` under the trigger's secret, constant-time
compare, body size cap, per-trigger rate limit. An optional `X-ShipIt-Delivery` header is
the dedupe key.

**Events.** A new BullMQ queue, `shipit-trigger-events`, with one consumer, the router in
the runner. Publishers:

| Source      | Types                                                    | Published by                                                                                                                                                                 |
| ----------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `github`    | the event name plus `action`, e.g. `pull_request.opened` | The existing receiver, after HMAC verification and delivery dedup, for every event the connector App delivers. Refetch behaviour for `push` and `workflow_run` is unchanged. |
| `connector` | `sync.completed`, `sync.failed`                          | `SyncScheduler` where it records a run.                                                                                                                                      |
| `graph`     | `entity.created`, `entity.updated`, `entity.absent`      | `core-writer` after a successful write or sweep. `markAbsent` returns the affected ids (capped) instead of a count.                                                          |

Payloads are small: ids, labels, the connector id, and for GitHub the fields a filter can
test (repository, ref, action, sender, PR number). The full GitHub payload is not queued.
Publishers check a Redis flag, `shipit-triggers-active~<source>`, that api-server sets
when at least one enabled trigger listens to that source; with no listener nothing is
published, so an installation without event triggers pays nothing. The queue has bounded
retention, and a publisher that finds more than `ai.triggers.maxQueuedEvents` jobs waiting
(default 10,000) skips the publish and increments a dropped-events counter that
`GET /ai/status` reports.

`filter` is a list of `{ path, op, value }` clauses, all of which must hold; `op` is one
of `eq`, `neq`, `in`, `contains`, `exists`, `matches` (glob). No expression language.

**Guards, applied by the router and recorded in `trigger_firings`:**

- **Dedupe.** `(trigger_id, dedupe_key)` is unique. The key is the delivery id, the event
  id, or the scheduler's fire time.
- **Rate limit.** At most `ai.triggers.maxRunsPerHour` runs per trigger (default 60);
  excess is recorded as `rate_limited`.
- **Loop guard.** Graph events caused by an agent carry that agent's id (from the claim
  source); GitHub events whose sender is the actions App are tagged the same way. A
  trigger does not fire for an event caused by its own target, or by any agent in a chain
  that already contains its target. `run_completed` chains stop at
  `ai.triggers.maxChainDepth` (default 10).

## Workflows

`workflow_versions.definition`:

```jsonc
{
  "nodes": [
    {
      "id": "start",
      "type": "start",
      "position": { "x": 0, "y": 0 },
      "config": { "inputSchema": null },
    },
    {
      "id": "review",
      "type": "agent",
      "position": { "x": 240, "y": 0 },
      "config": {
        "agentId": "…",
        "version": null,
        "input": "{{ input.pr }}",
        "onError": "fail",
        "maxVisits": 1,
      },
    },
    {
      "id": "risky",
      "type": "condition",
      "config": {
        "clauses": [{ "path": "nodes.review.output.data.risk", "op": "eq", "value": "high" }],
      },
    },
    {
      "id": "gate",
      "type": "approval",
      "config": { "message": "Open the fix PR for {{ input.pr.title }}?" },
    },
    { "id": "done", "type": "end", "config": { "output": "{{ nodes.review.output }}" } },
  ],
  "edges": [
    { "id": "e1", "from": "start", "to": "review" },
    { "id": "e2", "from": "review", "to": "risky" },
    { "id": "e3", "from": "risky", "to": "gate", "branch": "true" },
    { "id": "e4", "from": "risky", "to": "done", "branch": "false" },
  ],
}
```

| Node type   | Behaviour                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `start`     | Exactly one. Holds the run input.                                                                                                                 |
| `agent`     | Starts a child agent run with the templated input; its output becomes the node output. `version: null` means the published version at start time. |
| `condition` | Evaluates `clauses` (the trigger filter grammar) over workflow state; follows edges tagged `true` or `false`.                                     |
| `approval`  | Creates an approval with the templated message; `approved` follows edges tagged `approved`, `denied` follows `denied` or ends the branch.         |
| `join`      | Waits for `all` or `any` of its incoming edges.                                                                                                   |
| `end`       | One or more. The first to complete sets the run output; the run succeeds when no node is running or ready.                                        |

**Parallelism** is several outgoing edges from one node. **Loops** are edges that point
backwards; every cycle must pass through a node whose `maxVisits` is set (default 1, cap
20), and the validator rejects a definition where one does not.

**State and templates.** State is
`{ input, nodes: { <id>: { output, status, visits } } }`. A template is a string with
`{{ path }}` placeholders resolved against state; a string that is exactly one placeholder
yields the referenced JSON value, anything else is interpolated as text. No code runs.

**Engine.** A workflow run is a `runs` row of kind `workflow`. The engine is one function,
`advance(runId)`, run as a job on `shipit-workflow-runs`:

1. Lock the run row (`SELECT … FOR UPDATE`).
2. From `workflow_node_runs`, compute nodes that are ready: every required incoming edge
   satisfied, visit count under the cap.
3. Start each ready node: create the child run or approval, or evaluate the condition or
   join inline and loop to step 2.
4. If nothing is running, waiting or ready, finish the run.

`advance` is enqueued when the run is created, when a child run reaches a terminal status,
and when a workflow approval is decided. It is idempotent: it only moves nodes forward
from persisted state.

**Failure.** `onError` on an agent node is `fail` (the workflow run fails and running
children are cancelled), `continue` (the node output is `{ error }` and edges are
followed), or `retry` with `retries` (cap 3). Cancelling a workflow run cancels its
children.

**Validation at save:** one `start`; every node reachable from it; every edge end exists;
condition and approval edges carry valid branch tags; cycles are bounded; referenced
agents exist; templates reference known node ids.

**Engine-neutral format.** Nothing in the definition names BullMQ or our executor. A
later LangGraph.js executor would compile the same nodes and edges.

## API

All under `/api`, behind the existing root `require-auth`. Lists are paginated.
Definition updates require `If-Match` and return `409 VERSION_CONFLICT` with the server
revision on mismatch.

| Route                                                                                                                | Capability                                                          |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `GET /ai/status`                                                                                                     | any signed-in user                                                  |
| `GET /ai/models`, `GET /tools`                                                                                       | `agents:read`                                                       |
| `GET /agents`, `GET /agents/:id`, `GET /agents/:id/versions`                                                         | `agents:read`                                                       |
| `POST /agents`, `PUT /agents/:id`, `POST /agents/:id/publish`, `DELETE /agents/:id` (archive)                        | `agents:write`                                                      |
| `POST /agents/:id/runs` (body: `input`, `draft?`)                                                                    | `agents:run`                                                        |
| `GET /runs`, `GET /runs/:id`, `GET /runs/:id/messages`, `GET /runs/:id/stream`                                       | `agents:read`; transcripts additionally need `runs:read_transcript` |
| `POST /runs/:id/messages`, `POST /runs/:id/cancel`                                                                   | `agents:run`                                                        |
| `GET /approvals`, `POST /approvals/:id/decision`                                                                     | `approvals:decide`, or the agent's creator                          |
| `GET/POST/PUT/DELETE /triggers…`                                                                                     | `agents:write`                                                      |
| `POST /triggers/:id/webhook`                                                                                         | public, HMAC                                                        |
| `GET/POST/PUT/DELETE /workflows…`, `POST /workflows/:id/publish`                                                     | `agents:write`                                                      |
| `POST /workflows/:id/runs`                                                                                           | `agents:run`                                                        |
| `GET/POST/PUT/DELETE /tool-connections…`, `POST /tool-connections/:id/test`, `PUT /tool-connections/:id/tools/:name` | `ai:admin`                                                          |
| `GET /ai/github-app/manifest`, `GET /ai/github-app/callback`                                                         | `ai:admin`                                                          |

Capabilities: admins hold `*`. Members gain `agents:read` and `agents:run`. Tokens may be
minted with `agents:run` (added to `KNOWN_TOKEN_SCOPES`); the existing subset rule still
applies. `runs:read_transcript` is held by admins and granted per run to the agent's
creator and the user who triggered the run.

## Config

A new top-level `ai` section in the shared schema, all optional with defaults:

```yaml
ai:
  enabled: true # master switch; false hides the feature without touching data
  vertex: { project: '', location: global }
  models: [] # catalog, see Model layer
  defaultModel: ''
  runner: { concurrency: 4 }
  limits:
    {
      maxSteps: 25,
      maxTokens: 400000,
      timeoutSeconds: 900,
      dailyTokens: 4000000,
      toolResultChars: 50000,
      maxDepth: 3,
      chatIdleMinutes: 60,
    }
  approvals: { ttlHours: 24 }
  triggers: { maxRunsPerHour: 60, maxChainDepth: 10, maxQueuedEvents: 10000 }
  retention: { transcriptDays: 30, runDays: 180 }
```

`ai.limits` are ceilings: an agent's own limits may be lower, never higher.

## Secrets

| Name                        | Delivery                         | Used for                                                                                                                          |
| --------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | ESO env, `shipit_app` role       | api-server and runner. Registry entry, `required: false`.                                                                         |
| `SHIPIT_AGENT_PLATFORM_KEY` | ESO env, 32 random bytes, base64 | Root key. HKDF derives two subkeys: `enc` (AES-256-GCM over `secret_enc` columns, random nonce per value) and `run-token` (HMAC). |

Both are bootstrap-tier: delivered as env by ESO and never read from GSM by the app, which
avoids the 2026-09-16 boot-crash pattern. Vertex needs no secret. Rotating the platform
key requires re-encrypting `secret_enc` values; `secret_enc` carries a one-byte key
version so a later rotation tool can run both keys side by side. No rotation tool in v1.

## Web UI

**Nav.** A new **AI** group between Explore and Catalog:

| Entry      | Route           | Notes                                                                             |
| ---------- | --------------- | --------------------------------------------------------------------------------- |
| Ask        | `/ai/ask`       | Moved from `/ask`. Chat with a picked agent; defaults to the built-in assistant.  |
| Agents     | `/ai/agents`    | List, `/ai/agents/new`, `/ai/agents/[id]`.                                        |
| Workflows  | `/ai/workflows` | List, `/ai/workflows/[id]` (canvas).                                              |
| Activity   | `/ai/activity`  | Tabs: Runs, Approvals. Badge shows pending approvals. `/ai/runs/[id]` transcript. |
| Tools      | `/ai/tools`     | Catalog of every tool with service and effect; Connections tab (MCP, GitHub App). |
| MCP Access | `/ai/mcp`       | Moved from `/configure/mcp`, unchanged.                                           |

`next.config.mjs` gains redirects from `/ask`, `/configure/mcp` and
`/admin/agent-activity`. `header.tsx` `TRAILS`, the dashboard quick action, the API Keys
tab link, `docs/mcp-tools.md` and `docs/architecture.md` are updated.

**Agent editor.** A page, not a dialog. Left: Identity, Instructions, Model and limits,
Tools and permissions, Output. Right: the test panel. Tabs above: Definition, Triggers,
Runs, Versions. Draft saves use the ETag pattern; **Publish** is explicit and shows a diff
against the published version.

**Tools and permissions** is a matrix: one row per service the agent can see, columns
Read, Write, Delete, each a three-way control (Off, Allow, Ask; Delete offers Off and Ask
only). A row expands to per-tool overrides with each tool's description and effect.
Services with unclassified tools show a warning linking to the connection.

**Test panel and Ask** reuse `AskBar`, `CopilotMessage`, `ReasoningBlock`,
`ToolCallCard` and `Citation` from `@ship-it-ui/shipit`. A pending approval renders as a
card in the transcript with Approve and Deny; the same decision is available on the
Approvals tab.

**Run view.** Header (agent, version, trigger, status, tokens, duration), then the
transcript with every tool call showing service, effect, policy, decision, who approved,
duration and a collapsible input and output.

**Workflow canvas.** `GraphEditorCanvas` with a node renderer per type, an inspector per
node, a toolbar palette, and validation messages inline. Positions are saved in the
definition. A run overlay colours nodes by status and links each agent node to its child
run. A "tidy" action needs an auto-layout library (`dagre`); it is the one new UI
dependency.

**Empty and off states.** With agents unavailable, every `/ai/*` page except MCP Access
shows what is missing (database, schema version, Vertex project, runner heartbeat) from
`GET /ai/status`.

## Built-in agent

A migration-independent seed, written by api-server at boot when absent: **Graph
assistant** (`builtin: true`), read-only graph grants, the default model. It backs Ask out
of the box and cannot be deleted; an admin can edit and republish it.

## Graph projection

On publish and on archive, api-server publishes a `CanonicalEntity` on the event bus with
connector id `agents`, the way login publishes a `Person`. New node type `Agent` in
`config/shipit-schema.yaml` with properties `name`, `description`, `model`,
`write_services`, `enabled`; `Team -OWNS-> Agent` when `owner_team_id` is set. `agents`
joins the source-reliability registry. `lib/entity-types.ts` registers `Agent`. The catalog
entity page links to `/ai/agents/[id]`. Postgres stays the source of truth; the node is a
read-only mirror.

## Feature gating

`GET /ai/status` reports each prerequisite and an overall `available`:

| Check      | Unavailable when                                                                   |
| ---------- | ---------------------------------------------------------------------------------- |
| `enabled`  | `ai.enabled` is false                                                              |
| `database` | `DATABASE_URL` unset or unreachable                                                |
| `schema`   | `schema_migrations` behind `EXPECTED_SCHEMA_VERSION`                               |
| `models`   | `ai.vertex.project` empty or `ai.models` empty                                     |
| `runner`   | no heartbeat (`shipit-agent-runner-heartbeat`, written every 15s, 60s TTL)         |
| `key`      | `SHIPIT_AGENT_PLATFORM_KEY` unset (only connections and graph-write tools need it) |

When unavailable, agent routes return `503 AI_UNAVAILABLE` with the failing checks, and
the rest of the product is unaffected. Neither process exits because an agent prerequisite
is missing.

## Error handling

| Situation                                                 | Behaviour                                                                                                         |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Model call fails with a retryable error (429, 5xx)        | Up to 3 attempts with backoff inside the step. Then `MODEL_ERROR`.                                                |
| Model refuses or stops for safety                         | Run fails with `MODEL_REFUSED`; the provider's reason is stored.                                                  |
| Model returns invalid tool input                          | Schema validation fails in the gateway; the model gets an error result naming the problem and may retry.          |
| Tool throws                                               | `tool_calls.status = failed`; the model gets `{ error }`. The run continues.                                      |
| External MCP server unreachable                           | The first call fails as a tool error; the connection status flips to `error`.                                     |
| GitHub returns 403 or 404 for a repository                | Tool error stating the actions App is not installed on that repository.                                           |
| Approval expires                                          | Tool result "approval expired"; the run continues.                                                                |
| Runner crashes mid-run                                    | Stalled job redelivered; reads re-run, writes become `outcome_unknown`.                                           |
| Postgres unavailable mid-run                              | The job fails; the run stays `running`. A sweeper in the runner fails runs with no progress for 2× their timeout. |
| Published version references a tool that no longer exists | The tool is dropped from the resolved set; the run header shows a warning.                                        |
| Redis out of memory                                       | Error listeners keep both processes alive; enqueue failures return `503` to the caller.                           |

## Safety

- **Prompt injection.** Agents read text outsiders control (repository content, PR titles,
  webhook bodies, MCP results). Tool results and trigger payloads are always passed as
  data, never as instructions. The controls that matter are structural: write tools
  default to `ask`; runs from webhook and event triggers force `ask` on writes unless the
  trigger is set to `as_granted`; deletes are never unattended; GitHub writes cannot reach
  a default branch.
- **Confused deputy.** `agent.<slug>` needs an explicit grant and the child inherits the
  stricter write policy.
- **Outbound requests.** Connection URLs must be `https`. The host is resolved and
  rejected if any address is loopback, link-local (including `169.254.169.254`), private,
  or the cluster service range; redirects are not followed. The check runs at save and at
  every connect, since DNS can change.
- **Secrets.** Never in messages, logs or API responses. `secret_enc` values are
  write-only through the API. Tool inputs and outputs are stored; the Tools page says so,
  and transcript access is restricted (§API).
- **Spend.** Per-run token limit, per-agent daily cap, step limit, timeout, trigger rate
  limit, chain depth, runner concurrency. The infra budget alert is the backstop.
- **Data egress.** Every run sends graph content to Vertex AI in the owner's GCP project.
  The Agents page states this. With `ai.enabled: false` nothing leaves.
- **Public endpoints.** Only `POST /triggers/:id/webhook` is added to the public list. It
  verifies before parsing, caps body size, and rate-limits per trigger.
- **Redis.** Jobs carry ids only; transcripts never enter Redis; retention is bounded.

## Testing

| Layer                           | Tests                                                                                                                                                                                                                                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents` unit                   | Zod schemas (accept and reject tables); grant resolution, table-driven over every ceiling; template resolution; filter clauses; workflow validator (unreachable node, unbounded cycle, bad branch tag); crypto round-trips and tamper rejection.                                                          |
| `agents` integration (Postgres) | A fresh database gets every file in `db/migrations/` through `scripts/db-migrate.ts`, then each repository's methods run against it. This is the schema-drift guard. CI's `integration` job gains a `postgres` service; suites skip without `DATABASE_TEST_URL` and run serially, per the shared-DB scar. |
| runner unit, fake `ModelClient` | The loop over scripted model steps: allow, ask-then-approve, ask-then-deny, expiry, unknown tool, invalid input, parallel reads, sequential writes, results appended in call order, each limit, cancel, crash recovery for a read and for a write.                                                        |
| tool executors                  | Graph read handlers unchanged against existing fixtures; graph write through a fake api-server; GitHub executors against recorded API fixtures, including every guardrail rejection; MCP executor against an in-process MCP server; SSRF table.                                                           |
| triggers                        | Scheduler reconciliation; webhook signature, replay and rate limit; router matching, dedupe, rate limit and loop guard; `run_completed` chaining and depth cap.                                                                                                                                           |
| workflow engine                 | `advance` over scripted child outcomes: sequence, branch, parallel with `all` and `any` joins, approval, bounded loop, each `onError` mode, cancel, idempotent re-entry.                                                                                                                                  |
| api-server                      | Route gates per capability; ETag conflicts; run-token resolver (valid, tampered, wrong status); agent claim source; `AI_UNAVAILABLE` for each failing check; existing suites unchanged with `DATABASE_URL` unset.                                                                                         |
| mcp-server                      | Existing tool tests pass unchanged after the handler extraction.                                                                                                                                                                                                                                          |
| web-ui                          | Sidebar group and redirects; agent editor save, conflict and publish; permission matrix states; approval card; run view; workflow validation messages.                                                                                                                                                    |
| live, opt-in                    | A small suite gated on `VERTEX_TEST_PROJECT` runs the Milestone 1 spike checks against real models. Not in CI.                                                                                                                                                                                            |
| manual                          | The success criteria below on portal-demo.                                                                                                                                                                                                                                                                |

## Success criteria (v1 is done when)

On portal-demo, with Postgres, the runner and Vertex in place:

1. Ask answers "who owns X" and "what breaks if Y changes" through the built-in agent,
   with tool calls visible, on a Claude model and on a Gemini model.
2. An admin creates an agent with graph read `allow` and GitHub write `ask`, tests it in
   the panel, approves a pull-request tool call, and the pull request exists on a
   `shipit/` branch of a repository where the actions App is installed.
3. The same agent, asked to change a repository without the actions App, gets a tool error
   and no write happens. Asked to push to the default branch, the tool rejects it.
4. A schedule trigger, an inbound webhook, a `pull_request.opened` event trigger and a
   `run_completed` chain each start a run, and each run shows its trigger.
5. A webhook-triggered run with a write grant of `allow` still pauses for approval.
6. An agent sets a graph property; the Claim Explorer shows an `agent:` claim; a manual
   claim on the same property wins over it.
7. An external MCP server is connected, its tools classified, and an agent calls one.
8. A workflow with two agents, a condition, an approval gate and a bounded loop runs to
   completion from a trigger; the canvas shows node statuses live.
9. Killing the runner mid-run and restarting it resumes the run; a write in flight is
   reported as unknown and is not repeated.
10. A run that exceeds its token limit fails with `BUDGET_EXCEEDED`; an agent over its
    daily cap refuses to start.
11. With `DATABASE_URL` unset, the product behaves as it does today and the AI pages show
    setup guidance.
12. CI is green with the new unit and integration suites, and `pnpm audit` is clean.

## Infra (cross-repo, `shipit-ai-infra`)

- **Brief 1, written:** `docs/agent/briefs/infra-postgres-and-vertex-for-agents.md` —
  Postgres StatefulSet, two roles, `DATABASE_URL`, schema apply at deploy, Vertex API and
  service account, Model Garden enablement, budget alert, and the platform key container.
- **Brief 2, at Milestone 1:** `agent-runner` Deployment (no Service, `replicas: 1`, KSA
  `agent-runner`), image in `build-images.yml`, env (`DATABASE_URL`,
  `SHIPIT_AGENT_PLATFORM_KEY`, Redis, Neo4j, Vertex project and location, the in-cluster
  api-server URL), egress to GitHub and to configured MCP hosts.
- **Operator steps:** enable models in Model Garden; create and install the actions App
  per org from AI → Tools.

## Milestones

Build order inside the single release. Each gets its own plan, written when the previous
one is close to done, so later plans can use what earlier ones taught.

| #   | Milestone                | Contents                                                                                                                                                                                                                                         | Rough size |
| --- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| 0   | AI nav                   | Group, route moves, redirects, docs.                                                                                                                                                                                                             | 1–2 days   |
| 1   | Foundations, first agent | Vertex spike. `db/migrations`, `agents` package, compose and CI Postgres. Runner, model client, loop, limits. mcp-server handler extraction, graph read tools. Agent CRUD and editor, test panel, run view, Ask, built-in agent, feature gating. | 3–4 weeks  |
| 2   | Triggers and chaining    | Schedules, API runs and token scope, inbound webhooks, `run_completed`, trigger UI, Activity runs tab.                                                                                                                                           | 2 weeks    |
| 3   | Permissions and actions  | Grant matrix, approvals end to end, run tokens and graph write tools with the `agent` claim source, connections and external MCP, actions App and GitHub tools, Tools page.                                                                      | 4–5 weeks  |
| 4   | Event triggers           | Trigger queue, three publishers, router, guards.                                                                                                                                                                                                 | 2 weeks    |
| 5   | Workflows                | Definition and validator, engine, canvas UI spec and build, run overlay, agent-as-tool, graph projection.                                                                                                                                        | 4–6 weeks  |
| 6   | Release hardening        | Security review, success-criteria walkthrough on portal-demo, docs (`docs/ai-agents.md`, README), retention job.                                                                                                                                 | 1 week     |

Total is roughly 16 to 20 weeks for one developer working with coding agents. That is two
weeks more than the deep dive's estimate: GitHub code changes and the actions App are in
scope now, and release hardening is counted separately. These are estimates, not a
broken-down plan.

Nothing is user-visible until the release, except Milestone 0, which can merge on its own.
Milestones 1 to 5 merge to `main` behind `ai.enabled: false` in the committed config.

## To confirm in review

Choices made in this document that the owner has not explicitly seen:

1. **A separate GitHub actions App** (decision 8), instead of broadening the connector
   App. No existing installation has to re-approve anything; the cost is one more App to
   create per org.
2. **All `github.*` tools, including reads, go through the actions App.** A repository
   without it is invisible to agents even for reading files.
3. **The `agent` claim source ranked below `manual`** (decision 15), which touches the
   claims registry.
4. **Deletes can never be unattended** (decision 14).
5. **`pg` and plain SQL, no ORM** (decision 11), setting aside the earlier Drizzle
   recommendation.
6. **Members can run agents and see the run list; only admins create agents and read
   transcripts** (plus creator and triggering user per run).
7. **Open source versus Enterprise** is still undecided. Nothing here is gated by tier.

## Related

- `docs/agent/decisions/agent-platform-v1-foundations.md` — the owner's four decisions.
- `docs/agent/plans/ai-agents-and-workflows.md` — deep dive findings.
- `docs/agent/briefs/infra-postgres-and-vertex-for-agents.md` — infra hand-off.
- `docs/agent/decisions/api-server-config-persistence-strategy.md` — Postgres as Phase 2.
- `docs/agent/decisions/mcp-token-auth-stage-2a.md` — token model the run token sits beside.
- `docs/agent/decisions/etag-optimistic-concurrency-for-editable-config.md` — revision ETags.
- `docs/agent/decisions/core-writer-runs-as-its-own-process.md` — worker precedent.
- `docs/agent/decisions/webhook-receiver-design.md` — verify-first receiver the inbound webhook mirrors.
- `docs/agent/decisions/per-org-github-app-is-default-not-shared.md` — per-org App model the actions App follows.
- `docs/agent/scars/bullmq-5-forbids-colons-in-queue-names-and-job-ids.md`,
  `redis-memory-limit-below-dataset-oomkills.md`,
  `docker-builder-copies-fixed-package-set.md`,
  `integration-tests-sharing-a-db-must-run-serially.md` — constraints applied above.
- `ClaudePlans/01-auth-and-authorization.md`, `02-audit-and-observability.md` — the RBAC
  and telemetry work this design deliberately does not absorb.
