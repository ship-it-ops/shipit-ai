---
type: status
status: active
created: 2026-10-21
updated: 2026-10-27
author: claude-session-2026-10-21
branch: security-round-9
agent: none between sessions
tags: [security, dependabot, pnpm, audit]
importance: standard
---

# Security round 9 is on `security-round-9`, verified and pushed, draft PR open

## Scope

`pnpm-lock.yaml`; direct bumps in web-ui (next, eslint-config-next), api-server (fastify),
mcp-server (MCP SDK) and the four zod manifests; the vitest spec in the root and 13 workspace
manifests; the root `vite` override; the ninth round plus its 10-21 and 10-27 refreshes in
`decisions/dependabot-resolution-strategy.md`.

## Why

Dependabot alerts on `main` after #133, then two more waves of advisories while the branch
waited. The strategy note has the per-package reasoning.

## State

Fix commits `315fd70` to `48e47c5`, each verified on its own (typecheck, test, build); final
tree lint and format clean, `pnpm audit` empty. A draft PR is open for the branch
(`gh pr list --head security-round-9`); CI's Integration job is the first run of the
integration suites. The owner marks it ready and merges. Dependabot #138, #140 and #129 are
superseded and close themselves after merge.

## Done when

`gh pr list --head security-round-9 --state merged` lists a PR, or
`git ls-remote --exit-code --heads origin security-round-9` exits non-zero (branch deleted
after merge).
