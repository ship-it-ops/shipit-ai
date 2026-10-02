---
type: status
status: active
created: 2026-10-01
updated: 2026-10-02
author: claude-session-2026-09-30 (handoff written at context limit)
branch: ai-agents-design
agent: unassigned — next session picks this up
tags: [ai, agents, workflows, handoff, postgres, vertex]
importance: core
---

# Handoff: AI agents and workflows — design done, two plans written, nothing implemented yet

Read this first, then the spec. It replaces the conversation that produced it.

## Where things stand

The owner asked for an **AI** section in the left nav plus a builder for user-defined
agents, tool permissions, triggers and LangGraph-style workflows. Over one long session
that became a deep dive, four owner decisions, a design spec, an infra hand-off, and two
implementation plans. **No product code has been changed in this repo.**

| Stage                                      | State                                                                                  |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| Deep dive and options                      | Done. Owner reviewed.                                                                  |
| Owner decisions                            | Done (see below).                                                                      |
| Design spec                                | Written and committed. Owner said "GO ahead" after it; see "Not explicitly confirmed". |
| Infra brief                                | Written, committed here, and placed in the infra repo. Not yet worked.                 |
| Plan: AI nav (Milestone 0)                 | Written and committed. **Awaiting owner review.**                                      |
| Plan: agents foundation (M1, part 1)       | Written and committed, code proven in a clone. **Awaiting owner review.**              |
| Plan: runner, model layer, UI (M1, part 2) | **Not written, on purpose.** Blocked on the Vertex probe (foundation Task 9).          |
| Implementation                             | Not started.                                                                           |

## Waiting on the owner (ask this first)

Asked on 2026-10-02. Two of the three questions are settled:

- **Execution method: native.** Implement in-session with `superpowers:executing-plans`,
  one reviewer at the end. Applies to both plans.
- **Commit and push the docs: approved and done** (see Git state). That approval covered
  the docs commit only; every later commit and push needs its own.

Still open:

1. **Do the two plans capture what you want?** The owner had not read them yet on
   2026-10-02.

Do not start implementing until the owner has reviewed the plans and said so (superpowers
writing-plans handoff gate).

## Standing rules that bit or nearly bit this session

- **Never `git commit` or `git push` without explicit approval for that specific action.**
  "GO ahead" to a direct commit question counted; plan approval does not. Ask separately
  for push.
- **No `Co-Authored-By` or any AI trailer** in commit messages.
- **Never state a SHA, id or tag you did not read.** Run the command.
- Stop subagents when their task is done.
- The owner's pronouns have not been stated; use they/them.

## Git state

- Branch `ai-agents-design`, created from `main` at `fe5009c`. **Pushed** to `origin` on
  2026-10-02. No pull request yet.
- Two commits: `85aa05ce38599f75c20248fa0c97a91aca25cd58` (spec, infra brief, decision
  note, plan note, manifest) and a second one on top carrying the two plans, two spec
  corrections, the plan note, the manifest, this file and a secretlint allow-list (see
  "Facts that cost time"). Read its SHA with `git log -2 --format=%H ai-agents-design`.
- Git-ignored, local only: `ClaudePlans/agents-foundation-verified.patch` (see below).

## Documents, in reading order

1. `docs/superpowers/specs/2026-10-01-ai-agents-and-workflows-design.md` — the design for
   the whole first release. 17 decisions, data model, run loop, tool gateway, tool sources,
   triggers, workflow engine, API, UI, safety, testing, 7 milestones.
2. `docs/agent/decisions/agent-platform-v1-foundations.md` — the owner's four decisions.
3. `docs/superpowers/plans/2026-10-01-ai-nav-section.md` — 3 tasks.
4. `docs/superpowers/plans/2026-10-01-agents-foundation.md` — 9 tasks, about 5,100 lines
   because it carries every file in full.
5. `docs/agent/briefs/infra-postgres-and-vertex-for-agents.md` — what infra must provide.
6. `docs/agent/plans/ai-agents-and-workflows.md` — deep-dive findings and a running status.
7. Review doc the owner reads and comments on (private):
   https://claude.ai/code/artifact/85e0c975-a028-4c6b-90cf-0b3f0832092c — a Claude Docs
   document; edit it only through the Claude Docs connector, never by web fetch.

## What the owner decided (2026-10-01)

- **Storage:** Postgres. The infra repo creates the instance and applies schema changes.
- **Runtime:** our own agent loop in a new `agent-runner` process. Not Claude Managed
  Agents, not the Claude Agent SDK.
- **Models:** through Vertex AI, any model it offers (the rest of the infra is on GCP).
- **First release:** everything, working end to end. The milestones are build order
  inside one release, not separate releases.
- **Write and delete tools:** graph edits, external MCP servers, and GitHub, **including
  committing changes and opening a pull request**. Kubernetes stays read-only.
- Accepted defaults: our own workflow engine (BullMQ + Postgres state), admins-only agent
  creation, each agent its own principal, Ask becomes a chat with a built-in agent, the
  nav move may ship on its own.

### Not explicitly confirmed

The spec's last section, "To confirm in review", lists seven choices made on the owner's
behalf. They were shown to the owner, who replied "GO ahead" to a message that also asked
about committing and sending the brief. Treat them as accepted unless the owner says
otherwise, but they were never individually confirmed. The two most consequential:

- GitHub writes use a **separate "actions" App** (not broader connector-App permissions),
  and **all** `github.*` tools, including reads, go through it.
- Agent-written graph claims use a new `agent` source ranked **below `manual`**.

Still genuinely open: **open source versus Enterprise** (nothing is gated by tier).

## The foundation plan's verification status

Its code was built in an isolated clone, not in this working tree.

- **Passed in the clone:** workspace `pnpm turbo typecheck`; full `pnpm turbo test` with no
  regressions (api-server 674 passed, 56 of them new; agents 45 passed with 23 integration
  tests skipped); `pnpm format:check`; `pnpm db:migrate` error paths; the real
  `shipit.config.yaml` loading with the new `ai` section.
- **Database code:** 22 of 23 integration tests passed against an embedded Postgres
  (pglite) through a scratch-only adapter. The 23rd (two migrators at once) needs separate
  connections.
- **Never run:** the `pg`-driver harness (`packages/agents/src/__tests__/test-db.ts`)
  against a real Postgres; the api-server Docker image build; `docker compose up` with the
  new services; the Vertex probe. Docker was not running on the machine.
- **The nav plan's code was not run at all.** Its icon names and file paths were checked
  against the installed packages and the tree.

`ClaudePlans/agents-foundation-verified.patch` is the clone's full diff for foundation
Tasks 1 to 8 (44 files, +3752 / −19), taken against `85aa05c`. `git apply --check` passed
on this tree on 2026-10-01. It is the same code the plan shows. It is a convenience, not a
substitute for the plan's steps: applying it wholesale skips the per-task test runs and
the hands-on checks in Tasks 2, 4 and 8. If the owner chooses native execution, applying
it task by task (or using it to cross-check what you type) is reasonable; say so first.

## Prerequisites the next steps need

- **Docker running** — foundation Tasks 2, 4 and 8.
- **`gcloud auth application-default login`**, the Vertex AI API enabled on
  `ship-it-ai-portal`, and at least one Claude model enabled in Model Garden (a console
  step that includes accepting Anthropic's terms) — foundation Task 9. Only the owner can
  do the Model Garden step.
- Nothing for the nav plan.

## Next steps, in order

1. Get the owner's review of the two plans (the one question still open above).
2. Execute the nav plan (independent; can merge on its own).
3. Execute foundation Tasks 1 to 8. Task 9 (Vertex probe) can run in parallel whenever
   the GCP prerequisites are in place.
4. When Task 9 has reported, write the next plan: runner, model client, graph read tools,
   runs API, agent editor, run view, Ask, built-in agent (Milestone 1, second half). If
   the probe shows the JSON round trip of signed reasoning fails, the model layer for that
   family falls back to the direct SDKs behind the same `ModelClient` interface; nothing
   else in the design changes.
5. Write infra brief 2 (the `agent-runner` Deployment) once that image exists.

## Cross-repo state

- `~/Repos/Ship-It-Ops/shipit-ai-infra/docs/agent/status/incoming-brief-agent-platform-postgres-vertex-2026-10-01.md`
  — a copy of the brief, placed as an inbox entry. **Untracked there.** That repo's
  `MANIFEST.md` was not edited because it had another session's staged changes.
- Nobody has started the infra work. The app changes are safe to ship before it: with no
  `DATABASE_URL`, agent routes answer `503 AI_UNAVAILABLE` and everything else runs as
  today.
- The brief's contract the foundation plan relies on: migrations live in **this** repo at
  `db/migrations/NNNN_description.sql`; infra applies them at deploy, pinned to the image
  SHA, into `schema_migrations(version, applied_at)`; `DATABASE_URL` and
  `SHIPIT_AGENT_PLATFORM_KEY` arrive as plain env vars through ESO.

## Facts that cost time to establish (do not re-derive)

- **Nothing in the product calls a model today.** `/ask` is a hard-coded mock; no LLM SDK
  is installed; the "Phase 2 LLM seam" that `ClaudePlans/07` mentions does not exist.
- **Never put `DATABASE_URL` in the secrets registry.** `hydrateSecrets` reads every
  `consume: env` entry from GSM when its env var is unset, and the api-server has no grant
  on that container. That is the 2026-09-16 boot crash. It is a `${DATABASE_URL:-}`
  placeholder under `ai.database.url` instead.
- **AI SDK 7 names, typechecked against `ai@7.0.126` and `@ai-sdk/google-vertex@5.0.101`:**
  `generateText({ model, instructions, messages, tools, stopWhen: isStepCount(1) })`;
  `tool({ description, inputSchema: jsonSchema(...) })` with no `execute`;
  `result.toolCalls[i].{toolCallId, toolName, input}`; `result.responseMessages`;
  `result.usage.{inputTokens, outputTokens}`; tool results are
  `{ type: 'tool-result', toolCallId, toolName, output: { type: 'json', value } }`.
  Providers: `createVertex` (Gemini), `createVertexAnthropic` from `/anthropic`,
  `createVertexMaas` from `/maas`. Typechecked only; **never called live**.
- Claude ids on Vertex: `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-4-5@20251001`.
  No Gemini id was verified; the probe records one.
- `import { Pool } from 'pg'` works under this repo's NodeNext setup; `z.strictObject` and
  full-value `.default(...)` are the Zod 4 forms the repo uses.
- The MCP tool handlers are inline closures inside `server.tool(...)`; reusing them
  in-process needs the extraction the spec describes. That is in the next plan, not the
  foundation plan.
- The event bus is one BullMQ work queue with one consumer; a second `subscribe()` throws.
  Event triggers need a new queue (spec §Triggers).
- `@ship-it-ui/graph-editor` already ships `GraphEditorCanvas` (React Flow), used by the
  Schema Editor. The design-system ask in `ClaudePlans/08` was fulfilled.
- Icons that exist in `@ship-it-ui/icons`: `ask`, `sparkle` (same icon as `ask`), `bot`,
  `workflow`, `activity`, `package`, `server`, `shield`, `settings`. `cog`, `wrench` and
  `plug` do not.
- **Prettier reformats YAML and TS inside markdown fences** and strips their leading
  indentation. In plans, show partial-file edits as ```diff blocks, which it leaves alone.
- **secretlint flags Postgres URLs with an inline password**, in the husky pre-commit hook
  and in CI (`secretlint "**/*"`). The clone that proved the foundation code never ran it.
  On 2026-10-02 the owner approved a narrow allow-list in `.secretlintrc.json`: user
  `shipit`, passwords `shipit-dev` or `testpassword`, hosts `localhost`, `127.0.0.1` or
  `postgres`, port `5432`. Checked with that config: both plans pass, and a URL with any
  other password or host is still flagged. The `${POSTGRES_PASSWORD:-shipit-dev}` form
  used in `docker-compose.yml` and `scripts/infra.sh` passes without the allow-list.
- BullMQ is pinned at 5 and schedules with legacy repeatable jobs; BullMQ 6 removed them.
  New scheduling code should use Job Schedulers (`upsertJobScheduler`), available in 5.

## Found along the way, not acted on

- `packages/api-server/src/routes/connectors.ts` has **no role or capability gate**: any
  signed-in member can create, edit and delete connectors. Reported to the owner; not
  fixed, no issue filed.
- `backend.mcp.rateLimits.queryTimeoutMs` and `graphQueryPerDay` appear unused in
  `packages/mcp-server` although `docs/architecture.md` says they are enforced. Reported
  by a research subagent; not verified.

## Scope

Planned files are listed per task in the two plans. Until implementation starts, the only
files in play are under `docs/`.

## Why

`docs/agent/plans/ai-agents-and-workflows.md` and
`docs/agent/decisions/agent-platform-v1-foundations.md`.

## Done when

`commit 85aa05ce38599f75c20248fa0c97a91aca25cd58 on main`
(`git merge-base --is-ancestor 85aa05ce38599f75c20248fa0c97a91aca25cd58 origin/main`
exits zero).

That anchor only proves the design docs merged. **Do not let it archive this entry while
implementation is still in flight:** once an implementation PR exists, replace this
section with `PR #<n> merged`, or archive this file by hand and open a fresh status entry
for the work in progress.
