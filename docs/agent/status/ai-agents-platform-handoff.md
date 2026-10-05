---
type: status
status: active
created: 2026-10-01
updated: 2026-10-04
author: claude-session-2026-10-02 (agents workstream; handoff written 2026-10-04)
branch: ai-agents-design (to be merged; the work continues on a new branch from main)
agent: none (handed off)
tags: [ai, agents, workflows, handoff, postgres, vertex, web-ui]
importance: core
---

# Handoff: AI agents — backend is on `ai-agents-design`, ready to PR; next is the UI plan, on a new branch

Read this first, then the plan you are about to execute. It replaces the conversations that
produced it. The previous version of this note (longer, with the session-by-session history)
is in git: `git show 423e628:docs/agent/status/ai-agents-platform-handoff.md`.

## The owner's plan (2026-10-04)

1. **Open a PR for `ai-agents-design` and merge it.** The owner does this.
2. **Continue on a new branch from `main`.** The next piece of work is the agents UI plan,
   which is written and verified but **not executed and not yet approved**.

## What is on `ai-agents-design`

More than 70 commits ahead of `main` (base `fe5009c`; `main` has not moved since). Two
workstreams share the branch. Read the list with
`git log --oneline origin/main..origin/ai-agents-design`.

**Agents (this workstream):**

| Piece                                  | State                                                                                                        |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Design spec, owner decisions           | Done (`85aa05c`).                                                                                            |
| Milestone 0: AI nav                    | Implemented; final review clean.                                                                             |
| Milestone 1, part 1: agents foundation | Implemented (Postgres package, migrations, config, status service, definitions API); review fixes `545d6b8`. |
| Vertex probe                           | Gemini passes. Claude has zero quota (see "Waiting on the owner").                                           |
| Milestone 1, part 2: agent runner      | Implemented, 11 tasks (`8009189`..`0b3af28`); final review fixes `bb650d3`.                                  |
| Milestone 1, part 3: agents UI         | **Plan only** (`a0a87ec`): `docs/superpowers/plans/2026-10-04-agents-ui.md`. No UI code is on the branch.    |
| Fixes found on the way                 | MCP server no longer starts inside the api-server (`8825bd3`); `pnpm start:all` works again (`4447981`).     |

**Knowledge layer (another session):** K0 foundations and K1a GitHub text, with their own
plans, reviews and status note (`docs/agent/status/knowledge-k0-foundations.md`,
`docs/agent/plans/knowledge-connectors.md`). Not described here.

What a person can do after this branch merges: nothing new in the web UI beyond the AI nav
group (Agents is a placeholder page, Ask is still the mocked preview). Over HTTP, with a
database and a runner: create and publish agents, run them, chat, cancel, and follow a run
live. `docs/local-development.md`, "Running agents locally", has the commands.

## For the PR

**CI has never run on this branch.** It triggers only on pushes to `main` and on pull
requests, so the PR is its first run. A local rehearsal on the head `f3835a2`, in a clean
worktree, on 2026-10-04:

- Passed: `pnpm format:check`, `pnpm turbo lint` (warnings only, none new), secretlint over
  the whole repo, `pnpm turbo typecheck`, `pnpm turbo test --force`, `pnpm turbo build`.
- Passed, against Docker Postgres (pgvector) and Redis: integration suites for `agents` (49),
  `knowledge` (61), `agent-runner` (37) and `api-server` (46 passed, 42 skipped).
- Built: the `agent-runner` and `api-server` images.
- **Not rehearsed:** the `core-writer` and `event-bus` integration suites and the 42
  api-server tests that need a throwaway Neo4j (locally they would write to the dev graph);
  the `web-ui`, `core-writer`, `mcp-server` and `knowledge-worker` images.

**One decision before merging: `ai.enabled`.** The spec says "Milestones 1 to 5 merge to
`main` behind `ai.enabled: false` in the committed config" (spec line 918). The committed
`shipit.config.yaml` has `ai.enabled: true`, and the schema defaults to `true`; the database
URL is the gate in practice (no `DATABASE_URL`, no agent features). The knowledge layer does
follow the rule (`knowledge.enabled: false`). Not changed, because flipping it also turns
agents off in every local setup that does not say otherwise. To follow the spec:

- `shipit.config.yaml`: `ai.enabled: false`.
- `shipit.config.local.example.yaml` and the owner's `shipit.config.local.yaml`: add
  `enabled: true` under `ai:`.
- `docs/local-development.md`, "Postgres and agent features": say so.
- The schema default can stay `true`; only the committed YAML needs to say `false`.

**What merging switches on in a deployment.** Without `DATABASE_URL`: nothing; agent routes
answer `503 AI_UNAVAILABLE` and the log says "Agent features: off". With `DATABASE_URL` and
the migrations applied: the definitions API works and the api-server seeds the built-in Graph
assistant at boot; runs stay unavailable (`503`, check `runner`) until an `agent-runner`
Deployment exists.

**What infra must do** (briefs in `docs/agent/briefs/`):

- Apply `db/migrations/0001`..`0004`. `0002_knowledge.sql` needs the pgvector extension
  created first by a superuser (`pnpm db:bootstrap` does it locally).
- Build and deploy two new images: `agent-runner` (`infra-agent-runner.md`) and
  `knowledge-worker` (the knowledge session's brief).
- Vertex: `GOOGLE_CLOUD_PROJECT` for the runner, Workload Identity for credentials.
- Brief 1 (Postgres, the migration hook, Vertex service accounts) was worked in infra PR #91,
  open on 2026-10-03; its state has not been re-checked. A copy of that brief sits untracked
  in `~/Repos/Ship-It-Ops/shipit-ai-infra/docs/agent/status/`.

**For the PR description, the agents half:**

- An **AI** group in the nav (Ask, Agents, Workflows, Activity, Tools, MCP Access), with
  redirects from the old routes.
- `@shipit-ai/agents`: Postgres access, forward-only SQL migrations (`pnpm db:migrate`), agent
  definitions with versions and optimistic concurrency, runs with leases, transcripts, tool
  calls and per-day token usage.
- `agent-runner`: a new process. A BullMQ worker runs each agent as a loop over its stored
  transcript: one model step at a time on Vertex AI (AI SDK), the graph read tools reused
  in-process from the MCP server, limits per run and per day, cancel, multi-turn chat, and
  recovery when a worker dies (a read is re-run, a write is never repeated).
- api-server: `/api/ai/status`, `/api/ai/models`, `/api/agents` (create, edit, publish,
  archive), `/api/runs` (start, list, read, chat, cancel) and a live stream of each run over
  server-sent events; a built-in Graph assistant seeded at boot.
- Compose (`--profile agents`), CI (integration step, image build), local-dev docs.
- Plans, design spec and probe findings under `docs/`.

## Next session: start here

1. **Check the merge happened.** `git fetch origin`, then
   `git cat-file -e origin/main:packages/agent-runner/src/main.ts` exits zero once the backend
   is on `main`. Ask the owner for the new branch's name, or create one from `origin/main`.
2. **Get the UI plan approved.** The owner has not said the plan captures what they want. Its
   summary is in "The agents UI plan" below.
3. **Commit and push approval does not carry over.** The standing approval ("commit at each
   plan commit step, push after each commit") was given for `ai-agents-design`. Ask again for
   the new branch.
4. **Execute `docs/superpowers/plans/2026-10-04-agents-ui.md`** with
   `superpowers:executing-plans` (the owner chose native execution for every plan so far: one
   session implements all tasks, then one fresh reviewer on the most capable model).
   - Run `SHIPIT_API_URL=http://localhost:3001 pnpm build` first.
   - The plan's diffs were cut against `4447981`. Checked against `f3835a2` (the branch head):
     ten apply as written; the one for `packages/api-server/src/server.ts` needs
     `git apply --3way` and then merges cleanly. A squash merge does not change that: the
     diffs match on content.
   - Ask the owner to run `gcloud auth application-default login` before Task 9's browser
     check, or runs fail with `MODEL_ERROR` (`invalid_grant`).
5. **Then** the final review, and the plan for Milestone 2 (triggers and chaining: schedules,
   API runs and the `agents:run` token scope, inbound webhooks, `run_completed`, the trigger
   UI, the Activity runs tab). Milestones are in the spec's last table.

## The agents UI plan (not executed)

`docs/superpowers/plans/2026-10-04-agents-ui.md`, 9 tasks:

1. api-server: `GET /api/tools`; CORS allows `PUT`, `PATCH`, `DELETE` and exposes `ETag`.
2. web-ui: API client (`AgentApiError` keeps the conflict revision, validation issues and
   failing checks) and the live run stream.
3. Transcript model, answer text (a small Markdown subset as React elements, never HTML),
   transcript component, live-run hook.
4. AI off-states from `GET /api/ai/status`; the agents list.
5. Tools-and-permissions matrix with per-tool overrides.
6. Agent editor: draft save with `If-Match`, conflict and reload, publish with a diff,
   versions, runs, archive, read-only without `agents:write`.
7. One chat component for the test panel (runs the saved draft) and Ask (the built-in Graph
   assistant by default).
8. Run view and navigation.
9. Docs and a browser check.

How it was verified: built test-first in a scratch worktree; replayed task by task into a
clean one with every fail and pass step run; the plan text re-applied from scratch and
compared tree by tree with that replay (all 9 match). On the final state: web-ui 342 tests,
api-server 719 unit and 46 integration, a production `next build`. Every flow was exercised
in a browser against the real stack. **Not seen in the browser:** a model's answer arriving
in the test panel or Ask, because the local Google credentials had expired; those runs failed
cleanly and showed why. The run view did render a real earlier run with six tool calls.

Not in it, on purpose: the Triggers tab (Milestone 2), approval cards (Milestone 3), the
Activity list and the Tools page (they stay placeholders), a structured-output editor
(workflows milestone), the owner-team field.

## Waiting on the owner

1. **Review the UI plan.**
2. **`ai.enabled` in the committed config** (see "For the PR").
3. **`gcloud auth application-default login`.** The local credentials expired on 2026-10-04.
4. **Claude quota on Vertex.** `claude-sonnet-5-5`, `claude-opus-5-5` and
   `claude-haiku-4-5@20251001` answer 429 (zero quota on `global`). The owner said to wait 48
   hours before asking again, so from 2026-10-05. Then re-run the probe for Claude
   (`docs/agent/investigations/vertex-model-layer-probe.md`) and consider switching
   `ai.defaultModel` back from `gemini`.
5. **Local dev user capabilities.** `shipit.config.local.example.yaml` and the owner's local
   file set `frontend.devUser.capabilities: [admin]`. `admin` is not a capability name; only
   `*` is a wildcard, so with auth off the dev user gets 403 on every agents route. Change the
   example to `'*'`? Asked, not answered. For hands-on checks this workstream set `'*'` in a
   copy or temporarily, and restored the file.
6. **A per-user cap for Ask?** The daily token cap is per agent, so one person can use up the
   shared Graph assistant for everyone until the next UTC day. That is the spec's design.
7. **The deferred minors below.**

## Decisions made on the owner's behalf (not yet reviewed by them)

From executing the runner plan:

- `turbo.json`: the `dev` task passes `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` and
  `GOOGLE_APPLICATION_CREDENTIALS` through (turbo 2 strips undeclared variables), and
  `"concurrency": "20"` so 13 dev tasks can start.
- The daily cap counts tokens on the day they are spent, in a new table: migration
  `0004_agent_usage.sql`. The cheaper fix (count runs touched today) could falsely block the
  shared assistant after one conversation crossed midnight.
- Compose: `agent-runner` is behind `--profile agents` and mounts `~/.config/gcloud` as a
  directory. A missing credentials file used to be created as a directory by Docker.
- Left as designed after the final review set them aside: a failed chat turn ends the
  conversation; `ask` grants are not offered until approvals exist (Milestone 3); agents need
  the pgvector bootstrap because migration `0002` precedes `0003`; Claude and open models are
  untested; no cap on concurrent streams per user; `agents:run` is not a token scope yet; the
  run transcript endpoint is unpaginated; the runner image runs as root like the others.

**Deferred minors from the runner's final review** (not fixed):

- `sweep failed:` logs an empty message when Postgres refuses connections.
- Tool calls have no timeout or abort: a slow Cypher query outlives the run timeout and holds
  one of the four worker slots.
- `?afterSeq=` with an empty value skips message 0.
- A possible write after end when a stream shuts down.
- One agent lookup per row on the run list.
- Tool results are matched by call id alone.
- No re-entrancy guard on the sweep.
- A chat continues on a disabled or archived agent.
- A crash between appending a message and counting the step loses that step's usage.
- A model-auth failure shows Google's raw JSON as the run's error.

Earlier, from the foundation plan: nine minors in its ledger
(`.superpowers/sdd/2026-10-01-agents-foundation/progress.md`, git-ignored, local).

## Working next to the knowledge session

- It commits on the same branch and, so far, in the **same working tree**. Stage by path,
  never `git add -A`. Read `git diff` on a shared file before staging it.
- Its uncommitted, in-progress tests can break the workspace gate in the shared tree. Run the
  gate in a clean worktree checked out at your commit instead.
- Message it before touching `packages/api-server/src/{server,index}.ts`, `docker-compose.yml`,
  `ci.yml`, `docs/local-development.md`, `turbo.json`, `pnpm-lock.yaml` or adding a migration.
  **The next free migration number is `0005`.** Session names change between restarts; list
  the peers to find it.
- It asked to be told when the branch is PR-ready, so the PR description covers both halves.

## Standing rules

- **Never `git commit` or `git push` without the owner's approval for that action.** Plan
  approval is not commit approval.
- **No `Co-Authored-By` or any AI trailer** in commit messages.
- **Never state a SHA, id or tag you did not read.**
- Stop subagents when their task is done.
- The owner's pronouns have not been stated; use they/them.

## What the owner decided (2026-10-01), still binding

- **Storage:** Postgres. The infra repo creates the instance and applies schema changes; the
  app never migrates at boot.
- **Runtime:** our own agent loop in the `agent-runner` process. Not Claude Managed Agents,
  not the Claude Agent SDK.
- **Models:** through Vertex AI, any model it offers.
- **First release:** everything, working end to end. Milestones are build order inside one
  release.
- **Write and delete tools:** graph edits, external MCP servers, and GitHub including commits
  and pull requests. Kubernetes stays read-only.
- Accepted defaults: our own workflow engine, admins-only agent creation, each agent its own
  principal, Ask is a chat with a built-in agent.
- Never individually confirmed (spec, "To confirm in review"): GitHub writes go through a
  separate "actions" App; agent-written graph claims use a new `agent` source ranked below
  `manual`. Still open: open source versus Enterprise.

## Facts that cost time to establish

Environment and tooling:

- **Never run the compose file from another worktree.** Docker recreates the dev Postgres and
  Neo4j containers (scar `compose-from-another-worktree-recreates-dev-containers`). In a
  worktree, start only the Node processes: `pnpm exec turbo dev`.
- **Turbo 2 strips environment variables** a task does not declare. A variable that "is set"
  but never arrives is this.
- **CORS:** `@fastify/cors` 11 allows only `GET`, `HEAD`, `POST` and hides `ETag`. In local
  dev (UI on :3000, API on :3001) no save, edit or delete works from the browser. Already on
  `main`; fixed by the UI plan's Task 1.
- **Never put `DATABASE_URL` in the secrets registry** (the 2026-09-16 boot crash). It is a
  `${DATABASE_URL:-}` placeholder under `ai.database.url`.
- **secretlint** flags Postgres URLs with an inline password; `.secretlintrc.json` allows only
  user `shipit`, passwords `shipit-dev` or `testpassword`, hosts `localhost`, `127.0.0.1` or
  `postgres`, port 5432.
- **Prettier reformats code inside markdown fences.** In plans, wrap code blocks in
  `<!-- prettier-ignore-start -->` and `<!-- prettier-ignore-end -->`.
- `next dev` and test runs rewrite `packages/web-ui/next-env.d.ts`, and `next dev` may create
  `packages/web-ui/AGENTS.md` and `CLAUDE.md`. Restore or delete them; never commit them.
- A package's own `typecheck` needs its sibling packages built (`pnpm build` once, or go
  through `pnpm turbo typecheck`).
- In zsh, a shell variable named `path` replaces `PATH`.
- Integration suites: `DATABASE_TEST_URL=postgres://shipit:shipit-dev@localhost:5432/shipit`
  and `REDIS_TEST_URL=redis://localhost:6379`. Each creates and drops its own schema. Do not
  set `NEO4J_TEST_URI` to the dev graph: those suites write to it.

Models (details in `docs/agent/investigations/vertex-model-layer-probe.md`):

- Gemini's `thoughtSignature` rides on each tool-call part's `providerOptions`; dropping it
  does not fail, the SDK silently replays without the model's reasoning. Store messages
  verbatim.
- The AI SDK answers a call to an undeclared tool itself; the model client drops that message
  so the gateway records the call.
- With tools removed from a transcript that used them, Gemini invents tool names. On the last
  step the tools stay declared and a tagged note asks for an answer.
- On long transcripts Gemini heeds a trailing user message and ignores the same words in the
  instructions.

Web UI (for the plan's executor):

- The Radix `Select` is unreliable in jsdom; tests replace it with a native `<select>`.
- The design system's `NumberInput` ignores an empty value, so a test must replace the
  selected text instead of clearing and typing.
- Run `axe` on the render container, not on `document.body`.
- Icons that exist in `@ship-it-ui/icons`: `ask`, `sparkle`, `bot`, `workflow`, `activity`,
  `package`, `server`, `shield`, `settings`, `warn`. `cog`, `wrench` and `plug` do not.

How the plans are made (worth repeating for the next one): build in a scratch worktree
test-first; replay into a clean worktree one task at a time, snapshotting each task with
`git add -A && git write-tree`; generate every code block from the tree diffs; rebuild the
work from the plan's text alone and compare trees. The scripts were in a session scratchpad
and are gone; the method is what matters.

## This machine, as left on 2026-10-04

- Local Postgres is migrated to `0004`. It holds the built-in Graph assistant, an agent named
  Owners, one archived test agent (UI Check Agent) and a few test runs.
- Local Redis holds 50 graph-sync events the knowledge session queued; `core-writer` applies
  them at its next start. That is expected.
- `shipit.config.local.yaml` is as the owner had it (`capabilities` unchanged).
- Docker images `shipit-agent-runner:dev`, `shipit-agent-runner:rehearsal` and
  `shipit-api-server:rehearsal` can be deleted.
- `.superpowers/sdd/` (git-ignored) holds earlier plans' ledgers; the runner plan's was
  removed after its review.

## Documents, in reading order

1. `docs/superpowers/specs/2026-10-01-ai-agents-and-workflows-design.md` — the design for the
   whole first release: decisions, data model, run loop, tool gateway, triggers, workflows,
   API, UI, safety, testing, milestones.
2. `docs/superpowers/plans/2026-10-04-agents-ui.md` — the plan to execute next.
3. `docs/superpowers/plans/2026-10-03-agent-runner.md`, `2026-10-01-agents-foundation.md`,
   `2026-10-01-ai-nav-section.md` — executed; useful for how things were built.
4. `docs/agent/investigations/vertex-model-layer-probe.md` — what the models actually do.
5. `docs/agent/decisions/agent-platform-v1-foundations.md` — the owner's four decisions.
6. `docs/agent/briefs/infra-postgres-and-vertex-for-agents.md`, `infra-agent-runner.md`.
7. `docs/agent/plans/ai-agents-and-workflows.md` — deep-dive findings and a running status.
8. The owner's private review doc for the spec:
   https://claude.ai/code/artifact/85e0c975-a028-4c6b-90cf-0b3f0832092c (a Claude Docs
   document; edit it only through the Claude Docs connector).

## Scope

Until the UI plan is executed: `docs/` only. The UI plan's files are listed per task in it:
`packages/web-ui/src/{components/ai,lib,app/(app)/ai}`, plus
`packages/api-server/src/{routes/tools.ts,server.ts}` and two docs.

## Why

`docs/agent/plans/ai-agents-and-workflows.md` and
`docs/agent/decisions/agent-platform-v1-foundations.md`.

## Done when

The Milestone 1 UI is on `main`:
`git cat-file -e origin/main:packages/web-ui/src/components/ai/run-view.tsx` exits zero.

When that holds, archive this entry and open a fresh status entry for Milestone 2. Until then
this entry stays active, including after `ai-agents-design` merges.
