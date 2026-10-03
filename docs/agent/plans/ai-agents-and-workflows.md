---
type: plan
status: active
created: 2026-09-30
updated: 2026-10-02
author: claude-session-2026-09-30
tags: [ai, agents, workflows, mcp, permissions, postgres]
importance: core
---

# AI section: user-defined agents, triggers and workflows (deep dive, pre-spec)

## Goal

Add an **AI** group to the left nav, move the existing AI pages into it, and add a
builder where users define agents (name, instructions, model, tools, per-service
read/write/delete access), attach triggers, chain agents, and eventually compose
LangGraph-style workflows.

This note records the deep dive only. **No option is decided yet** — the user is
reviewing. Full write-up with diagrams:
https://claude.ai/code/artifact/85e0c975-a028-4c6b-90cf-0b3f0832092c

## Findings that constrain the design (verified in code, 2026-09-30)

- **No LLM seam exists.** No LLM SDK in any `package.json`; no `/api/ask`. `/ask` is a
  hard-coded mock (`ask-shell.tsx`, `mock-conversation.ts`). The "Phase 2 LLM seam in
  the reconciliation flow" that `ClaudePlans/07` plans to reuse was never built.
- **`/admin/agent-activity` is a placeholder**; nothing logs MCP tool calls.
  `/configure/mcp` is real.
- **All 8 MCP tools are read-only**, one scope (`mcp:invoke`) unlocks all, no per-tool
  check. Handlers are inline closures inside `server.tool(...)` in
  `packages/mcp-server/src/tools/*.ts` — not callable in-process without a refactor
  (extract plain functions, or use the MCP SDK in-memory transport).
- **No write path to any external service.** `ShipItConnector` is ingest-only; the
  GitHub App manifest is all `read`; the K8s role is `get, list, watch`.
- **No relational store** (no pg/drizzle/prisma/sqlite). Postgres is the planned
  Phase 2 in [api-server-config-persistence-strategy](../decisions/api-server-config-persistence-strategy.md), unbuilt.
- **Event bus is a single BullMQ work queue with one consumer** (`EventKind =
'entities' | 'sync.completed'`; a second `subscribe()` throws). No entity-changed
  event. The webhook receiver acts on `push` and `workflow_run` only.
- **Jobs run inside api-server** (pinned to 1 replica), no `attempts`/`backoff`
  configured anywhere, scheduling uses legacy `repeat: { pattern }` which BullMQ 6
  removed in favour of Job Schedulers (repo pins `^5.79.1`).
- **Reusable UI:** `GraphEditorCanvas` from `@ship-it-ui/graph-editor` (React Flow;
  used by the Schema Editor — the DS ask in `ClaudePlans/08` was fulfilled),
  `WizardDialog`, and the chat set in `@ship-it-ui/shipit` (`AskBar`, `ToolCallCard`,
  `ReasoningBlock`, `Citation`). Gaps: no auto-layout, node positions not persisted.
- **Side finding, out of scope:** `routes/connectors.ts` has no role or capability
  gate — any authenticated member can create, edit and delete connectors.

## Approach (recommended, awaiting user decision)

1. **Runtime:** our own agent loop in a new `agent-runner` process (core-writer
   precedent) on a model SDK, with a tool gateway that enforces grants, pauses for
   approvals, holds credentials and logs every call. Keep a runtime interface so
   Claude Managed Agents can be an optional runtime later.
2. **Storage:** Postgres for definitions, versions, grants, triggers, runs, steps.
   Mirror each agent into the graph as a `ServiceAccount` node (type `ai_agent`).
3. **Permissions:** each tool declares `service` + `effect` (read/write/delete);
   grants are off / allow / ask per service and effect; an agent never exceeds its
   creator; credential scope is the hard ceiling.
4. **UX:** form-first agent editor with a live test panel; canvas only for workflows.
5. **Workflows:** agent chaining as a trigger first; engine choice (own on BullMQ vs
   LangGraph.js) deferred to the workflow phase. Store workflows as our own
   nodes-and-edges JSON so either engine can execute it.

Rejected-for-now alternatives and why are in the linked doc (Managed Agents, Claude
Agent SDK, Mastra, Temporal, Inngest, Vercel Workflow SDK).

## Phases (rough sizes, unvalidated)

| Phase | Ships                                                                    | Size      |
| ----- | ------------------------------------------------------------------------ | --------- |
| 0     | AI nav group; move Ask, MCP Access, Activity; redirects                  | 1–2 days  |
| 1     | Runner, gateway, 8 graph tools, agent editor, manual runs, Ask goes live | 3–4 weeks |
| 2     | Schedules, API/webhook triggers, run B after A, run history              | 2 weeks   |
| 3     | Grant matrix, approval inbox, external MCP, first write tools            | 3–4 weeks |
| 4     | Event triggers via a new fan-out channel                                 | 2 weeks   |
| 5     | Workflow canvas and engine                                               | 4–6 weeks |

## Files to Touch (phase 0 only; later phases get their own spec)

- `packages/web-ui/src/components/layout/sidebar.tsx` — new AI group
- `packages/web-ui/src/components/layout/header.tsx` — breadcrumb `TRAILS`
- `packages/web-ui/src/components/dashboard/quick-actions.tsx`, `components/settings/api-keys-tab.tsx` — hard-coded links
- `packages/web-ui/next.config.mjs` — redirects (none exist today)
- `docs/mcp-tools.md`, `docs/architecture.md` — old MCP Access path

## Status

Deep dive delivered 2026-09-30. The owner answered the four foundation questions on
2026-10-01 — see [agent-platform-v1-foundations](../decisions/agent-platform-v1-foundations.md):
Postgres with infra-applied schema, own runner, Vertex AI for any model, and **all
phases in one first release** (the table above is now build order, not release order).

Infra hand-off written: [infra-postgres-and-vertex-for-agents](../briefs/infra-postgres-and-vertex-for-agents.md)
(not yet sent to the infra repo).

On 2026-10-01 the owner also settled the remaining scope: write and delete tools for
graph edits, external MCP servers and GitHub (including committing changes and opening
a PR); Kubernetes stays read-only; own workflow engine, admins-only agent creation and
per-agent principals accepted as defaults.

**Spec written, awaiting owner review:**
`docs/superpowers/specs/2026-10-01-ai-agents-and-workflows-design.md`. It supersedes the
Approach and Phases sections above where they differ (seven milestones, 16 to 20 weeks,
a separate GitHub "actions" App instead of broader connector-App permissions, AI SDK
Vertex provider as the model layer, `pg` with plain SQL instead of an ORM).

The owner said "go ahead" on 2026-10-01; the spec, brief and notes were committed on
branch `ai-agents-design` (`85aa05c`, not pushed) and the brief was placed in the infra
repo as `docs/agent/status/incoming-brief-agent-platform-postgres-vertex-2026-10-01.md`.

**Implementation plans written, awaiting owner review** (on 2026-10-02 the owner chose
native, in-session execution and had the plans committed and pushed on `ai-agents-design`):

- `docs/superpowers/plans/2026-10-01-ai-nav-section.md` — Milestone 0 (3 tasks).
- `docs/superpowers/plans/2026-10-01-agents-foundation.md` — first half of Milestone 1
  (9 tasks): `@shipit-ai/agents` package, `db/migrations/0001_agents.sql`, `pnpm db:migrate`,
  the `ai` config section, `/api/ai/status`, `/api/ai/models`, the `/api/agents` definitions
  API, and a Vertex probe. Its code was proven in an isolated clone (workspace typecheck,
  full test suite and format check green; SQL exercised on an embedded Postgres). Not yet
  run: the `pg` harness against a real Postgres, the image build, the Vertex probe.

Milestone 1's second half (runner, model layer, tools, runs, UI) is deliberately not
planned yet: its model-client code depends on what the Vertex probe finds.

Two spec corrections were made while planning: `agents` gained a `draft_definition`
column, and `DATABASE_URL` is a plain env placeholder rather than a secrets-registry entry
(a registry entry would be read from GSM at boot, which is the 2026-09-16 crash).

**Milestone 0 (AI nav) implemented** per `docs/superpowers/plans/2026-10-01-ai-nav-section.md`:
routes moved under `/ai`, redirects in `packages/web-ui/legacy-redirects.mjs`, three
placeholder pages (Agents, Workflows, Tools) until their milestones land.

## Related

- [api-server-config-persistence-strategy](../decisions/api-server-config-persistence-strategy.md) — Postgres as planned Phase 2; scheduler must leave api-server before replicas > 1
- [mcp-token-auth-stage-2a](../decisions/mcp-token-auth-stage-2a.md) — per-tool scope granularity is a listed revisit trigger
- [core-writer-runs-as-its-own-process](../decisions/core-writer-runs-as-its-own-process.md) — precedent for the agent-runner process
- [bullmq-5-forbids-colons-in-queue-names-and-job-ids](../scars/bullmq-5-forbids-colons-in-queue-names-and-job-ids.md) — applies to any new queue
- [redis-memory-limit-below-dataset-oomkills](../scars/redis-memory-limit-below-dataset-oomkills.md) — why transcripts must not live in Redis
