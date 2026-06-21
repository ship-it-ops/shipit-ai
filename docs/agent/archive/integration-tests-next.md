---
type: status
status: completed
created: 2026-06-19
updated: 2026-06-20
author: claude-session-2026-06-20-gsm-itest
branch: next-release
agent: claude-session-2026-06-20-gsm-itest
tags: [testing, integration-tests, handoff]
---

# Integration-test roadmap: COMPLETE — all 10 items + both unit follow-ups DONE

Every prioritized gap and both cheap follow-ups are closed and committed to `next-release`. The Neo4j
(Wave A), Redis/BullMQ (Wave B + #3), GSM (Wave C), and fake-IdP/GitHub (Wave D = #9 + #8) seams are
covered. A+B (incl. #3) run in the CI `integration` job; #9 + #8 + the unit follow-ups run in the
DEFAULT unit suite. GSM (#5) is local-opt-in (no CI creds).

Commits: #5 GSM ee370d3 · #3 sync-runtime 2944be7 · #9 OIDC 77da7ff · #8 manifest 2d497c3 · unit
follow-ups (this commit). The plans
[integration-test-coverage-roadmap](../plans/integration-test-coverage-roadmap.md) +
[integration-tests-wave-cd-handoff](../plans/integration-tests-wave-cd-handoff.md) are now `completed`
and retain the full per-item record + harness recipe for the next agent.

- ~~**#5 GSM** boot hydration~~ ✅ ee370d3
- ~~**#3 sync-scheduler NoopRunner**~~ ✅ 2944be7 (`services/sync-runtime.ts` + tests)
- ~~**#9 OIDC exchange/PKCE**~~ ✅ 77da7ff (cookie/proxy half was already in `routes/auth.test.ts`)
- ~~**#8 manifest acceptance**~~ ✅ 2d497c3 (ENOENT clear-error + x-forwarded-host + POST shape)
- ~~**unit follow-ups**~~ ✅ `find-root.test.ts` (5) + `queries.test.ts` (10, sanitizers now exported)

Initiative complete — this note is archived.
