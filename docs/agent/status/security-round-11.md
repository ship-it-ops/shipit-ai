---
type: status
status: active
created: 2026-11-02
updated: 2026-11-02
author: claude-session-2026-11-02
branch: security-round-11
agent: none between sessions
tags: [security, dependabot, pnpm, audit]
importance: standard
---

# Security round 11 is on `security-round-11`: hono node-server 2.1.6, glob 14, minimatch 11; draft PR #150

## Scope

Root `package.json` (`pnpm.overrides` gains `@hono/node-server`, `glob@10`, `minimatch@10`) and
`pnpm-lock.yaml`; the eleventh round in `decisions/dependabot-resolution-strategy.md`; the
round-10 status note archived.

## Why

The audit on `12b2635` (round 10's merge) found three moderates published 10-28 to 10-30, none a
Dependabot alert yet. The strategy note's 2026-11-02 section has the per-package reasoning, the
tooling note (`pnpm update` now drags rolldown along; use an override plus
`pnpm install --lockfile-only`), and the one residual: minimatch 3.1.5 under eslint 9, which has
no fix and whose vulnerable code does not exist in 3.x.

## State

Three fix commits, each verified on its own (`turbo typecheck test build` 39/39; audit 5 → 1;
lint unchanged at 18 warnings, 0 errors). Round 10's `sha-12b2635` was deployed at the start of
this round (infra deploy run 41583754595). Draft PR #150 opened 2026-11-02; the owner marks it ready
(that starts the public review job) and merges. After merge: audit on the merge SHA, then build-images and deploy, as for round 10.

## Done when

PR #150 merged: `gh pr view 150 --json state -q .state` prints `MERGED` (the branch is
deleted on merge, so `git ls-remote --exit-code --heads origin security-round-11` exiting
non-zero is the same signal).
