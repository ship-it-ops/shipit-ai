---
type: status
status: active
created: 2026-10-03
updated: 2026-10-03
author: claude-session-2026-10-01-knowledge-connectors
branch: ai-agents-design
agent: claude-session-2026-10-01-knowledge-connectors
tags: [knowledge, connectors, postgres, pgvector, worker]
importance: core
---

# Implementing knowledge layer K0 (foundations) on `ai-agents-design`

Executing `docs/superpowers/plans/2026-10-03-knowledge-foundations.md` natively, task by task,
in this working tree. **Another session (the agents workstream) commits on the same branch
and tree**; if that is you, these are the files this work touches, so coordinate before editing
them:

## Scope

- New: `packages/knowledge/`, `packages/knowledge-worker/`, `db/migrations/0002_knowledge.sql`,
  `docker/postgres-init/`, `packages/connector-sdk/src/knowledge/`
- Modified: `docker/docker-compose.yml` (postgres image, migrate command, knowledge-worker
  service), `.github/workflows/ci.yml` (postgres image, knowledge integration step, docker
  matrix), `scripts/infra.sh`, root `package.json` (`db:bootstrap`), root `vitest.config.ts`,
  `packages/agents/src/schema-version.ts` (→ `0002`), `packages/shared/src/config/schema.ts`
  (`knowledge` section, `LastRun.facet`), `shipit.config.yaml`,
  `packages/api-server/src/__tests__/test-config.ts`, `packages/api-server/src/services/connector-types/types.ts`
  (`build` optional, `buildKnowledge`), `packages/api-server/src/services/sync-scheduler.ts`
  (guards + `context` getter), `packages/api-server/src/server.ts`, `packages/api-server/src/index.ts`
  (shared pool, knowledge status + scheduler wiring), `packages/api-server/{package.json,vitest.config.ts,Dockerfile}`.

## Why

[knowledge-connectors](../plans/knowledge-connectors.md); owner approved the spec and the K0
plan on 2026-10-03.

## Done when

`branch ai-agents-design deleted on remote`
(`git ls-remote --exit-code --heads origin ai-agents-design` exits non-zero). Replace with
`PR #<n> merged` once the branch has a pull request.
