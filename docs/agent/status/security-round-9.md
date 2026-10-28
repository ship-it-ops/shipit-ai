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

# Security round 9 is on `security-round-9`, verified and pushed, PR #141 open

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
tree lint and format clean, `pnpm audit` empty. PR #141 is open for the branch; the first
CI run (opened as a draft) passed all 15 checks, including the Integration job's first run of
the integration suites. Marked ready for review on 2026-10-27 so the review job runs on this
push; squash-merge once it approves. Dependabot #138, #140 and #129 are superseded and close
themselves after merge.

## Done when

PR #141 merged: `gh pr view 141 --json state -q .state` prints `MERGED` (the branch is
deleted on merge, so `git ls-remote --exit-code --heads origin security-round-9` exiting
non-zero is the same signal).
