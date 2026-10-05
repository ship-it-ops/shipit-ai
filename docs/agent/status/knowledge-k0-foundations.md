---
type: status
status: active
created: 2026-10-03
updated: 2026-10-05
author: claude-session-2026-10-01-knowledge-connectors
branch: ai-agents-design
agent: claude-session-2026-10-01-knowledge-connectors
tags: [knowledge, connectors, postgres, pgvector, worker]
importance: core
---

# Knowledge layer on `ai-agents-design`: K0 and K1a are in pull request #119, reviewed and fixed, waiting for the owner to merge; K1b plan next

The branch is up as [#119](https://github.com/ship-it-ops/shipit-ai/pull/119). A review of the
whole pull request and fresh reviews of each batch of its fixes are done and their findings
fixed ([knowledge-connectors](../plans/knowledge-connectors.md), "Pull request #119 and its
review"). The merge is the owner's: the branch protection needs their admin bypass. After it,
this work continues on a new branch from `main`, starting with the K1b plan.

K0 is implemented, reviewed and pushed (`37ee7eb`..`52650e1`, review fixes in `b5882bf`; see
[knowledge-connectors](../plans/knowledge-connectors.md) for the list). An independent audit on
2026-10-04 found nine bugs and three SDK contract gaps; all are fixed on the branch (plan note,
"Independent audit" and "Audit fixes"). K1a (GitHub text) is implemented from `docs/superpowers/plans/2026-10-04-knowledge-github-text.md` and its whole-range review is fixed; the one open item is the first live Vertex embedding, which waits for the owner to refresh the machine's Application Default Credentials. The K1b plan is next. This note stays while the knowledge work continues on this
branch. **Another session (the agents workstream) commits on the same branch
and tree**; if that is you, these are the files this work touches, so coordinate before editing
them:

## Scope

- K1a added: `packages/connectors/github/src/knowledge/`, `packages/api-server/src/routes/connector-containers.ts`,
  `packages/knowledge-worker/src/housekeeping.ts`, and the `knowledge` block on the GitHub connector schema
  (`packages/shared/src/config/schema.ts`); it also changed `routes/connectors.ts` (admin gate),
  `middleware/require-auth.ts`, `server.ts` and `index.ts`.
- New: `packages/knowledge/`, `packages/knowledge-worker/`, `db/migrations/0002_knowledge.sql`,
  `docker/postgres-init/`, `packages/connector-sdk/src/knowledge/`
- Modified: `docker/docker-compose.yml` (postgres image, migrate command, knowledge-worker
  service), `.github/workflows/ci.yml` (postgres image, knowledge integration step, docker
  matrix), `scripts/infra.sh`, root `package.json` (`db:bootstrap`), root `vitest.config.ts`,
  `packages/agents/src/schema-version.ts` (now `0003`, with the agents workstream's `0003_runs.sql`), `packages/shared/src/config/schema.ts`
  (`knowledge` section, `LastRun.facet`), `shipit.config.yaml`,
  `packages/api-server/src/__tests__/test-config.ts`, `packages/api-server/src/services/connector-types/types.ts`
  (`build` optional, `buildKnowledge`), `packages/api-server/src/services/sync-scheduler.ts`
  (guards + `context` getter), `packages/api-server/src/server.ts`, `packages/api-server/src/index.ts`
  (shared pool, knowledge status + scheduler wiring), `packages/api-server/{package.json,vitest.config.ts,Dockerfile}`.

## Why

[knowledge-connectors](../plans/knowledge-connectors.md); owner approved the spec and the K0
plan on 2026-10-03.

## Done when

`PR #119 merged` (`gh pr view 119 --json state -q .state` prints `MERGED`).
