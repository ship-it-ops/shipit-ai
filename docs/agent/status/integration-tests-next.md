---
type: status
status: active
created: 2026-06-19
updated: 2026-06-19
author: claude-session-2026-06-19-cutb-exec
branch: next-release
agent: claude-session-2026-06-19-cutb-exec
tags: [testing, integration-tests, handoff]
---

# Integration-test roadmap: Waves A+B DONE, C/D + #3 remain — HANDOFF ready

34 integration tests now cover the Neo4j (Wave A) and Redis/BullMQ (Wave B) seams, all in the
CI `integration` job, all merged to `next-release`. The next agent should pick up the rest.

**Read [integration-tests-wave-cd-handoff](../plans/integration-tests-wave-cd-handoff.md)** — it has
the copy-paste harness recipe, the local-validation container commands, the standing rules, and a
per-item build guide for the remaining work:

- **#5 GSM** boot hydration (do first — "pod won't boot" class; needs real GCP/emulator)
- **#3 sync-scheduler NoopRunner** silent-degradation (cheap-ish)
- **#9 OIDC/proxy login** (if OIDC users)
- **#8 manifest acceptance** (onboarding-only)
- plus two cheap UNIT follow-ups (`find-root.ts`, `sanitizeLabel`/`sanitizeProperties`).

Recommended order: #5 → #3 → #9 → #8.
