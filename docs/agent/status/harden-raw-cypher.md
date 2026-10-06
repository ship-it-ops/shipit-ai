---
type: status
status: active
created: 2026-10-05
updated: 2026-10-05
author: claude-session-2026-10-05-raw-cypher-hardening
branch: harden-raw-cypher
agent: claude-session-2026-10-05-raw-cypher-hardening
tags: [security, cypher, neo4j, mcp, query-playground]
importance: core
---

# Raw Cypher: one read-only check and one executor for the Query Playground and `graph_query`

A small branch from `main` (`d966fa2`), separate from the knowledge work on `knowledge-k1b`.
Two surfaces run Cypher that a caller wrote: the Query Playground (`POST /api/query`) and the
`graph_query` MCP tool. Each had its own check and its own way of running the query. This
branch gives them one of each. The design and its reasons are in
[raw-cypher-read-only-guard](../decisions/raw-cypher-read-only-guard.md).

The repository is public: describe what this branch closes by its class and its fix, here and
in commits and the pull request, and keep anything more specific for the owner in the session.

## Scope

- New: `packages/shared/src/cypher/read-only-guard.ts` (the check, pure text),
  `packages/mcp-server/src/cypher/read-only-query.ts` (the executor), their tests.
- New: `packages/mcp-server/src/daily-budget.ts`.
- Changed: `packages/mcp-server/src/tools/graph-query.ts`, `neo4j-client.ts`, `tools/registry.ts`,
  `tools/metadata.ts`, `errors.ts` (a `SERVER_BUSY` code), `index.ts` (the token on each HTTP
  request), `package.json` (a `./cypher` export); `packages/api-server/src/routes/query.ts`
  (admin or `graph:query`), `routes/tokens.ts` (the scope), `services/cypher-query-service.ts`,
  `vitest.config.ts`; `packages/agent-runner/src/__tests__/graph-tools.test.ts`;
  `packages/shared/src/auth/request-context.ts` (`GRAPH_QUERY_CAPABILITY`),
  `types/query-api.ts`; `packages/web-ui/src/components/layout/sidebar.tsx`,
  `app/(app)/explore/query/page.tsx`, `components/query/result-grid.tsx`,
  `components/settings/api-keys-tab.tsx`, `components/onboarding/onboarding-dialog.tsx`,
  `lib/api.ts`; `docs/mcp-tools.md`, `plugin/skills/shipit-cypher/SKILL.md`,
  `plugin/skills/shipit-debugging/SKILL.md`.
- Removed: `packages/api-server/src/services/cypher-safety.ts` (replaced by the shared check).
- Not touched: `packages/api-server/src/{server,index}.ts`, the lockfile, migrations.

## Why

Chosen by the owner on 2026-10-05 as the first work after pull request #119, ahead of the K1b
plan. `graph_query` stays withheld from agents (`agents: false` in the tool metadata); offering
it to them again is the owner's decision, not part of this branch.

## Done when

The pull request for this branch is merged:
`gh pr list --head harden-raw-cypher --state merged --json number -q length` prints `1`.
(It prints `0` until then, also before the branch has a pull request.)
