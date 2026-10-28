---
type: status
status: active
created: 2026-10-28
updated: 2026-10-28
author: claude-session-2026-10-21
branch: security-round-10
agent: none between sessions
tags: [security, dependabot, pnpm, audit]
importance: standard
---

# Security round 10 is on `security-round-10`: qs 6.17.0, verified and pushed, PR #142 open

## Scope

`pnpm-lock.yaml` only (qs 6.16.0 → 6.17.0 under express, one copy left); the tenth round in
`decisions/dependabot-resolution-strategy.md`; the round-9 status note archived.

## Why

The pre-build audit on `22fe475` (round 9 merged, #141) found qs moderate
GHSA-6pq8-jhm2-2vcw, published between that branch's last audit and the merge. The strategy
note has the reasoning and the decision to build 22fe475 first.

## State

One fix commit, verified on its own (typecheck, test, build 39/39, 2,319 tests; audit
1 → 0). Draft PR #142 opened 2026-10-28 and marked ready the same morning so the review job
runs on this push; squash-merge once it approves. Round 9's `22fe475` is live: built as
`sha-22fe475` (infra build run 40629457416) and deployed (infra deploy run 40704903347),
`/api/health` 200 and `/` → 307 to login. Dependabot alert #184 closes on merge. After
merge: audit on the merge SHA, then build-images and deploy, as for round 9.

## Done when

PR #142 merged: `gh pr view 142 --json state -q .state` prints `MERGED` (the branch is
deleted on merge, so `git ls-remote --exit-code --heads origin security-round-10` exiting
non-zero is the same signal).
