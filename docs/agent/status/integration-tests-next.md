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

# Integration-test roadmap: A+B+C + #3 + #9 DONE, only #8 remains — HANDOFF ready

The Neo4j (Wave A), Redis/BullMQ (Wave B + #3), GSM (Wave C), and OIDC (Wave D/#9) seams are covered.
A+B (incl. #3) are in the CI `integration` job; #9 runs in the DEFAULT unit suite (fetch-stubbed, no
real dep). **Wave C (#5 GSM) is committed (ee370d3)** but local-opt-in (NOT CI-enforced — no GCP creds).
#3 committed 2944be7. **#9 (OIDC) is done + green but UNCOMMITTED** as of this note.

**Read [integration-tests-wave-cd-handoff](../plans/integration-tests-wave-cd-handoff.md)** — it has
the copy-paste harness recipe, the local-validation container commands, the standing rules, and a
per-item build guide. Only **#8 (manifest acceptance, onboarding-only)** + two cheap UNIT follow-ups
remain:

- ~~**#5 GSM** boot hydration~~ ✅ DONE, committed ee370d3 (`secrets/{gsm-store,hydrate}.integration.test.ts`)
- ~~**#3 sync-scheduler NoopRunner** silent-degradation~~ ✅ DONE, committed 2944be7 (`services/sync-runtime.ts` + tests)
- ~~**#9 OIDC exchange/PKCE**~~ ✅ DONE 2026-06-20 (`__tests__/services/auth/oidc-provider.test.ts`,
  fetch-stubbed real openid-client); cookie/proxy half was already in `routes/auth.test.ts`. UNCOMMITTED.
- **#8 manifest acceptance** (NEXT — onboarding-only, last roadmap item)
- plus two cheap UNIT follow-ups (`find-root.ts`, `sanitizeLabel`/`sanitizeProperties`).

Recommended order: ~~#5~~ → ~~#3~~ → ~~#9~~ → #8.
