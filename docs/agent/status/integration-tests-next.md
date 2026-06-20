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

# Integration-test roadmap: Waves A+B+C DONE, #3/#9/#8 remain — HANDOFF ready

42 integration tests now cover the Neo4j (Wave A), Redis/BullMQ (Wave B), and GSM (Wave C) seams.
A+B are in the CI `integration` job and merged. **Wave C (#5 GSM) is done + validated against real
GCP but UNCOMMITTED** as of this note, and is local-opt-in (NOT CI-enforced — no GCP creds in CI).

**Read [integration-tests-wave-cd-handoff](../plans/integration-tests-wave-cd-handoff.md)** — it has
the copy-paste harness recipe, the local-validation container commands, the standing rules, and a
per-item build guide for the remaining work:

- ~~**#5 GSM** boot hydration~~ ✅ DONE 2026-06-20 (`secrets/{gsm-store,hydrate}.integration.test.ts`)
- **#3 sync-scheduler NoopRunner** silent-degradation (NEXT — cheap-ish)
- **#9 OIDC/proxy login** (if OIDC users)
- **#8 manifest acceptance** (onboarding-only)
- plus two cheap UNIT follow-ups (`find-root.ts`, `sanitizeLabel`/`sanitizeProperties`).

Recommended order: ~~#5~~ → #3 → #9 → #8.
