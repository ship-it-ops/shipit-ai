---
type: status
status: active
created: 2026-06-19
updated: 2026-06-20
author: claude-session-2026-06-20-gsm-itest
branch: next-release
agent: claude-session-2026-06-20-gsm-itest
tags: [testing, integration-tests, handoff]
---

# Integration-test roadmap: Waves A+B+C + #3 DONE, #9/#8 remain — HANDOFF ready

48 integration tests now cover the Neo4j (Wave A), Redis/BullMQ (Wave B + #3), and GSM (Wave C) seams.
A+B (incl. #3) are in the CI `integration` job. **Wave C (#5 GSM) is committed (ee370d3)** but is
local-opt-in (NOT CI-enforced — no GCP creds in CI). **#3 (sync-scheduler NoopRunner) is done +
validated against real Redis but UNCOMMITTED** as of this note (awaiting commit approval).

**Read [integration-tests-wave-cd-handoff](../plans/integration-tests-wave-cd-handoff.md)** — it has
the copy-paste harness recipe, the local-validation container commands, the standing rules, and a
per-item build guide for the remaining work:

- ~~**#5 GSM** boot hydration~~ ✅ DONE 2026-06-20, committed ee370d3 (`secrets/{gsm-store,hydrate}.integration.test.ts`)
- ~~**#3 sync-scheduler NoopRunner** silent-degradation~~ ✅ DONE 2026-06-20 (`services/sync-runtime.ts`
  - `__tests__/services/sync-runtime{,.integration}.test.ts`); real-Redis validated; UNCOMMITTED
- **#9 OIDC/proxy login** (NEXT — if OIDC users)
- **#8 manifest acceptance** (onboarding-only)
- plus two cheap UNIT follow-ups (`find-root.ts`, `sanitizeLabel`/`sanitizeProperties`).

Recommended order: ~~#5~~ → ~~#3~~ → #9 → #8.
