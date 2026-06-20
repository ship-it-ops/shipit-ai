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

# Integration-test roadmap: ALL 10 items DONE — only 2 cheap unit follow-ups remain

Every prioritized gap is closed. The Neo4j (Wave A), Redis/BullMQ (Wave B + #3), GSM (Wave C), and
fake-IdP/GitHub (Wave D = #9 + #8) seams are covered. A+B (incl. #3) run in the CI `integration` job;
#9 + #8 run in the DEFAULT unit suite (fetch-stubbed, no real dep). **#5 GSM committed ee370d3**
(local-opt-in, no CI creds). #3 committed 2944be7. #9 committed 77da7ff. **#8 is done + green but
UNCOMMITTED** as of this note.

**Read [integration-tests-wave-cd-handoff](../plans/integration-tests-wave-cd-handoff.md)** — harness
recipe, local-validation container commands, standing rules, per-item build guide. Only the two cheap
UNIT follow-ups remain (NOT integration):

- ~~**#5 GSM** boot hydration~~ ✅ DONE, committed ee370d3 (`secrets/{gsm-store,hydrate}.integration.test.ts`)
- ~~**#3 sync-scheduler NoopRunner** silent-degradation~~ ✅ DONE, committed 2944be7 (`services/sync-runtime.ts` + tests)
- ~~**#9 OIDC exchange/PKCE**~~ ✅ DONE, committed 77da7ff (`__tests__/services/auth/oidc-provider.test.ts`); cookie/proxy half was already in `routes/auth.test.ts`
- ~~**#8 manifest acceptance**~~ ✅ DONE 2026-06-20 (buildManifest ENOENT clear-error + x-forwarded-host + POST shape); UNCOMMITTED
- **Remaining:** two cheap UNIT follow-ups — `shared/.../find-root.ts` (SHIPIT_CONFIG missing/walk-up)
  and `core-writer/.../neo4j/queries.ts` `sanitizeLabel`/`sanitizeProperties` (Cypher-injection-shaped).

Once those land (or are explicitly deferred), this status note can be archived — the roadmap is complete.
