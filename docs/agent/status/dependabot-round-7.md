---
type: status
status: active
created: 2026-09-28
updated: 2026-09-28
author: claude-session-2026-09-28
branch: dependabot-round-7
agent: claude-session-2026-09-28
tags: [dependabot, deps, security, vite]
---

# Dependabot round 7 — aggregate the 9 open Dependabot PRs into one

## Scope

- Root `package.json` (`pnpm.overrides` — the `vite` pin), `packages/web-ui/package.json`,
  `pnpm-lock.yaml`.
- 7 of the 9 open PRs (#79, #84, #97, #102, #104, #106, and all of #107 but `@types/react*`) are
  already on `main` via #108 — close as superseded.
- Real work: `@types/react*` residue of #107, #46 (`@vitejs/plugin-react` 6 via vite 8),
  re-test #40 (eslint 10), and 3 moderate `pnpm audit` advisories (undici, ip-address).

## Why

[dependabot-resolution-strategy](../decisions/dependabot-resolution-strategy.md) — round 7.

## Done when

Branch `dependabot-round-7` deleted on remote (the repo auto-deletes head branches on merge —
`k8s-connector-followups` went the same way after #115).
