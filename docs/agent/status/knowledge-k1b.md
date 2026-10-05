---
type: status
status: active
created: 2026-10-05
updated: 2026-10-05
author: claude-session-2026-10-01-knowledge-connectors
branch: knowledge-k1b
agent: claude-session-2026-10-01-knowledge-connectors
tags: [knowledge, connectors, linking, postgres]
importance: core
---

# Knowledge layer: K1b on `knowledge-k1b`, starting with its plan

K0 (foundations) and K1a (GitHub text) are on `main` (`d966fa2`, pull request #119). This
branch, cut from that commit, is for K1b: the alias dictionary, deterministic linking of
documents to graph entities, references between documents, people matching, and the timeline
and document routes. The first thing on it is the K1b implementation plan, written against the
code on `main`; nothing of K1b is implemented yet, and the plan needs the owner's approval
before it is executed.

The agents workstream runs in parallel, from `main`, in its own git worktree
([ai-agents-platform-handoff](ai-agents-platform-handoff.md)). This checkout is the knowledge
session's. Infra (the compose services) is started from this checkout only.

## Scope

- Expected: `packages/knowledge/`, `packages/knowledge-worker/`, `packages/connector-sdk/src/knowledge/`,
  `packages/connectors/github/src/knowledge/`, `packages/api-server/src/routes/` (knowledge and
  container routes), `packages/api-server/src/services/knowledge*`, a migration at `0005` or
  later, `docs/superpowers/plans/` (the K1b plan).
- Shared with the agents workstream, so coordinate before editing:
  `packages/api-server/src/{server,index}.ts`, `packages/agents/src/` (the migrator and
  `db.ts`), `docs/local-development.md`, `pnpm-lock.yaml`, and the next migration number.

## Why

[knowledge-connectors](../plans/knowledge-connectors.md), "Next". The spec is
`docs/superpowers/specs/2026-10-02-knowledge-connectors-design.md`.

## Open before K1b can be called done

- The first live Vertex embedding has never run: the machine's Application Default
  Credentials are expired (`gcloud auth application-default login`, the owner's to run).
- The GitHub App lacks "Issues: read", so issues are skipped with the note
  `issues_permission_missing`.

## Done when

The pull request for this branch is merged:
`gh pr list --head knowledge-k1b --state merged --json number -q length` prints `1`.
(It prints `0` until then, also before the branch has a pull request.)
