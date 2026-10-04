---
type: status
status: active
created: 2026-10-01
updated: 2026-10-04
author: claude-session-2026-09-30 (handoff written at context limit)
branch: ai-agents-design
agent: claude-session-2026-10-02 (executing the plans)
tags: [ai, agents, workflows, handoff, postgres, vertex]
importance: core
---

# Handoff: AI agents and workflows — M0 nav, M1 foundation and the agent runner built; UI plan in progress

Read this first, then the spec. It replaces the conversations that produced it.

## Where things stand

The owner asked for an **AI** section in the left nav plus a builder for user-defined
agents, tool permissions, triggers and LangGraph-style workflows. The design, two
implementation plans, and the code for both plans (except the foundation plan's Task 9
spike) are on branch `ai-agents-design`, pushed. No pull request yet.

| Stage                                    | State                                                                            |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| Deep dive, owner decisions, design spec  | Done.                                                                            |
| Infra brief                              | Worked in infra PR #91 (open 2026-10-03). Vertex APIs already live.              |
| Plan: AI nav (Milestone 0)               | Approved 2026-10-02. **Implemented**, final review: ready to merge.              |
| Plan: agents foundation (M1, part 1)     | Approved 2026-10-02. **Tasks 1–8 implemented**; final review fixes in `545d6b8`. |
| Foundation Task 9 (Vertex probe)         | Gemini **passed**; Claude **blocked**: zero quota on `global` (429).             |
| Plan: agent runner (M1, part 2, backend) | **Implemented** (`8009189`..`0b3af28`); final review fixes in `bb650d3`.         |
| Plan: agents UI (M1, part 3)             | Being written; see "Next" below.                                                 |

## Waiting on the owner

1. **Claude quota on Vertex.** Infra enabled the APIs and the models resolve, but
   `claude-sonnet-5-5`, `claude-opus-5-5` and `claude-haiku-4-5@20251001` all answer 429
   "Quota exceeded for …global_online_prediction_requests_per_base_model … Please submit a
   quota increase request." A quota increase per Claude family on `global` is needed; then
   re-run the probe for Claude (see the investigation note). **The owner must wait 48 hours
   before requesting Claude again (said 2026-10-03), so not before 2026-10-05.** Meanwhile
   `ai.defaultModel` is `gemini`; switch it back once Claude passes the probe.
2. **Local dev user capabilities.** `shipit.config.local.example.yaml` (and the owner's
   local copy) set `frontend.devUser.capabilities: [admin]`. `admin` is not a capability
   name; only `*` is a wildcard. With auth off, the local dev user therefore gets 403 on
   every capability-gated route (the new `/api/agents*` and `/api/ai/models`, and the
   existing `graph:write` manual-edit routes). Change the example to `'*'`? Not changed yet.

3. **Local Google credentials expired again (2026-10-04).** Vertex answers `invalid_grant`
   (`invalid_rapt`) for the application-default credentials, so no local run can reach a model
   until the owner runs `gcloud auth application-default login`. The runner fails such a run
   cleanly with `MODEL_ERROR`.
4. **The pull request.** The knowledge session relayed the owner's decision: no PR until the
   agents work is complete, then the branch goes up as a whole. Tell the owner and the
   knowledge session when it is PR-ready.
5. **A per-user cap for Ask?** The daily token cap is per agent, so one person can use up the
   shared Graph assistant for everyone until the next UTC day. That is the spec's design; say
   if a per-user cap is wanted.

Owner approvals on 2026-10-02: both plans ("good to go"); native execution; commit at each
plan commit step and push after each commit on `ai-agents-design`. Pushing elsewhere,
opening a PR or merging still needs its own approval.

## The agent-runner plan (2026-10-03)

`docs/superpowers/plans/2026-10-03-agent-runner.md`: 11 tasks, Milestone 1's backend (runner
process, Vertex model client, graph read tools, run loop, runs API, live stream, built-in
Graph assistant). Every task was built and tested in a scratch worktree, replayed in order into
a clean one with each task's checks, and the plan text was then re-applied from scratch and
compared byte-for-byte with that replay. The UI half of Milestone 1 is the next plan.

**Rebased onto K0, then executed (2026-10-03 to 04).** The plan's diffs are against `52650e1`.
All 11 tasks are on the branch, one commit each (`8009189` mcp registry, `7356c83` run store,
`cb92201` tool resolution and queue, `22b0471` model client, `84730e2` graph tools, `2811f55`
run loop, `242d432` process/image/compose/CI, `b62b98a` runs API, `0e9733f` stream, `4735083`
built-in agent, `0b3af28` docs and infra brief 2). The hands-on check passed against real
Gemini: a chat on the Graph assistant answered from the local graph, a follow-up resumed the
stream, and neither a SIGTERM with a viewer nor a Postgres outage broke anything.

**Decisions made while executing** (the owner has not reviewed these yet):

- `turbo.json`: the `dev` task passes `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` and
  `GOOGLE_APPLICATION_CREDENTIALS` through. Turbo 2 strips undeclared variables, so
  `GOOGLE_CLOUD_PROJECT=… pnpm start:backend` reached no process.
- The workspace gate ran in a clean worktree at each commit while the knowledge session had
  uncommitted work in the shared tree.

**Final review (Opus; the Fable reviewer hit the account's usage limit before reporting).** No
Critical findings, 6 Important, 9 Minor. Fixed in `bb650d3`, each with a test that failed first:

- The stream response carried no CORS headers, so a browser on another origin (local dev)
  could not read it.
- A stream could hang open: it now also catches up on its 15 s keep-alive tick.
- With Redis down the run routes hung: the heartbeat read (2 s) and the enqueue (3 s) are bounded.
- Sweeper gaps: a queued run whose job was lost is queued again after a minute; a cancelled run
  whose worker died is finished as cancelled; a takeover no longer resets the stall clock.
- The lease owner was one name per process: each claim now has its own, so a worker slot that
  lost a run cannot write to it.
- The daily cap missed tokens spent after midnight by a chat begun earlier: migration
  **`0004_agent_usage.sql`** (`agent_usage_daily`), `EXPECTED_SCHEMA_VERSION` **`'0004'`**.
- Re-graded up from Minor: a last-step note ("you cannot call tools any more") was replayed on
  later chat questions; the compose `agent-runner` service is now behind `--profile agents` and
  mounts the gcloud directory (a missing credentials file used to become a directory).

**Deferred minors** (not fixed; the owner decides): empty `sweep failed:` log text; tool calls
have no timeout or abort (a slow Cypher query outlives the run timeout and holds a worker
slot); `?afterSeq=` (empty) skips message 0; a possible write after end on stream shutdown; one
agent lookup per row on the run list; tool results matched by call id alone; no re-entrancy
guard on the sweep; a chat continues on a disabled or archived agent; a crash between append
and `recordStep` loses that step's usage; a model-auth failure shows Google's raw JSON as the
run's error.

**Left as designed** (reviewer set these aside; they stand unless the owner says otherwise): a
failed chat turn ends the conversation; `ask` grants are not offered until approvals
(Milestone 3); agents need the pgvector bootstrap because migration `0002` precedes `0003`;
Claude and open models are untested (no quota); `agents:run` is not a token scope yet
(Milestone 2); the runner image runs as root like the others.

## Next: the Milestone 1 UI plan

In progress in a scratch worktree, not on the branch yet: an API client and live-stream hook,
the transcript view, the AI off-states, the agents list, the tools-and-permissions matrix, the
agent editor (draft save with `If-Match`, publish with a diff, versions, runs, archive), the
test panel and Ask on a shared chat component. Still to build: the run view and navigation.
The plan will be `docs/superpowers/plans/2026-10-04-agents-ui.md`; the owner reviews it before
execution (native, as before).

Found while building it, fixed in `8825bd3`: the mcp-server entry started its server whenever the
process script ended in `index.js`, so every api-server process also ran an MCP server on port
3002, and `pnpm start:mcp` (`tsx src/index.ts`) ran none. It now compares real paths, and the
api-server imports `@shipit-ai/mcp-server/metadata`.

## Standing rules that bit or nearly bit this session

- **Never `git commit` or `git push` without explicit approval for that specific action.**
  "GO ahead" to a direct commit question counted; plan approval does not. Ask separately
  for push.
- **No `Co-Authored-By` or any AI trailer** in commit messages.
- **Never state a SHA, id or tag you did not read.** Run the command.
- Stop subagents when their task is done.
- The owner's pronouns have not been stated; use they/them.

## Git state

- Branch `ai-agents-design`, created from `main` at `fe5009c`, pushed to `origin`. No PR.
- Read the commit list with `git log --oneline fe5009c..origin/ai-agents-design`. In order:
  design docs; plans + secretlint allow-list; three nav commits (M0); eight foundation
  commits (Tasks 1–8). This status note may be one commit behind; trust `git log`.
- Git-ignored, local only: `ClaudePlans/agents-foundation-verified.patch` (the clone's
  diff for foundation Tasks 1–8). Every file written for Tasks 1–8 was byte-compared
  against it; all matched. It can be deleted.
- Execution ledgers (git-ignored): `.superpowers/sdd/2026-10-01-agents-foundation/progress.md`.

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

## Verification done on this machine (2026-10-02)

- Workspace typecheck, all tests, lint (no new warnings), format check, after every task.
  api-server 674 passed / 51 skipped; agents 45 unit + 23 integration.
- `agents` integration suites **23/23 against a real Postgres 17** in Docker, including the
  two-concurrent-migrators test the clone could not run.
- Hands-on (Task 8): create 201 `etag: "1"`, update 200 `etag: "2"`, stale `If-Match`
  409 `VERSION_CONFLICT` `serverRevision: 2`, publish `publishedVersion: 1`, list total 1;
  Postgres stopped → `/api/agents` 503 naming `database`, `/api/health` 200, process
  survives, recovers without restart; no database → "Agent features: off", health 200,
  agents 503.
- api-server Docker image builds and ships `migrate-cli.js`; the compose `migrate` service
  (`docker compose run --rm migrate`) applies from `/app/db/migrations`.
- Nav: `next dev` curl check of all redirects, query string kept.
- Final reviews: nav ready to merge (no fixes); foundation "with fixes", both Important
  findings fixed test-first in `545d6b8` (10 s statement timeout on the pool, migrator
  opts out; If-Match/paging values bounded so they cannot surface as a fake 503). Nine
  Minors deferred, listed in the foundation ledger.
- Vertex probe (Task 9), 2026-10-03, owner's refreshed ADC: Gemini 3 (`gemini-3.8-flash`,
  `gemini-3.1-pro-preview`) passes every check; Claude not reachable (quota). Findings:
  `docs/agent/investigations/vertex-model-layer-probe.md`. `gemini` added to `ai.models`.

## Next steps, in order

1. When Claude quota exists, re-run the probe for Claude (plan Task 9 Steps 1–3; the
   directory takes a minute to recreate) and finish the investigation note.
2. Write the next plan from the probe's findings (Gemini is enough to start; the runner
   must store `providerOptions` verbatim, see the note): runner, model client, graph read tools,
   runs API, agent editor, run view, Ask, built-in agent (Milestone 1, second half). If the
   JSON round trip of signed reasoning fails for a family, that family's model layer falls
   back to the direct SDK behind the same `ModelClient` interface.
3. Open a PR for `ai-agents-design` when the owner wants one (M0 and the M1 foundation are
   safe to ship before infra: with no `DATABASE_URL` agent routes answer 503).
4. Write infra brief 2 (the `agent-runner` Deployment) once that image exists.

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
