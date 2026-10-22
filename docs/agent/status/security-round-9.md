---
type: status
status: active
created: 2026-10-21
updated: 2026-10-21
author: claude-session-2026-10-21
branch: security-round-9
agent: none between sessions
tags: [security, dependabot, pnpm, audit]
importance: standard
---

# Security round 9 is on `security-round-9`, verified and pushed, waiting for its PR

## Scope

`pnpm-lock.yaml`, the vitest spec in the root and 13 workspace manifests, the root `vite`
override, `packages/mcp-server/package.json`, and the ninth round plus its 2026-10-21 refresh
in `decisions/dependabot-resolution-strategy.md`.

## Why

Dependabot alerts on `main` after #133, then fifteen more advisories while the branch waited.
The strategy note has the per-package reasoning.

## State

Five commits ahead of `main` (`315fd70` to `4fa8de3`). Full local verification green
(typecheck, test, build, lint, format); `pnpm audit` 17 → 2, the two left (braces,
sprintf-js) have no patched version and are dev-only. **No PR yet**: the owner opens PRs here,
as a draft (the CI review posts publicly otherwise). Dependabot #138 (MCP SDK 1.32.0) is
superseded by this branch and closes itself after merge.

## Done when

`gh pr list --head security-round-9 --state merged` lists a PR, or
`git ls-remote --exit-code --heads origin security-round-9` exits non-zero (branch deleted
after merge).
