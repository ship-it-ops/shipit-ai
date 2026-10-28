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

# Security round 10 is on `security-round-10`: qs 6.17.0, verified and pushed, PR not yet opened

## Scope

`pnpm-lock.yaml` only (qs 6.16.0 → 6.17.0 under express, one copy left); the tenth round in
`decisions/dependabot-resolution-strategy.md`; the round-9 status note archived.

## Why

The pre-build audit on `22fe475` (round 9 merged, #141) found qs moderate
GHSA-6pq8-jhm2-2vcw, published between that branch's last audit and the merge. The strategy
note has the reasoning and the decision to build 22fe475 first.

## State

One fix commit, verified on its own (typecheck, test, build 39/39, 2,319 tests; audit
1 → 0). Pushed; the owner decides on the PR. Dependabot alert #184 closes on merge. After
merge: audit on the merge SHA, then build-images and deploy, as for round 9.

## Done when

`gh pr list --head security-round-10 --state merged` lists a PR, or
`git ls-remote --exit-code --heads origin security-round-10` exits non-zero (branch deleted
after merge).
