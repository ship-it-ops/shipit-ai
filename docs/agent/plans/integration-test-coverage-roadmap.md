---
type: plan
status: active
created: 2026-06-19
updated: 2026-06-19
author: claude-session-2026-06-19-cutb-exec
tags: [testing, integration-tests, reliability, neo4j, redis, bullmq, gsm, roadmap]
importance: core
---

# Integration-test coverage roadmap

## Goal

The repo has exactly ONE real-dependency test (`core-writer/.../freshness-guard.integration.test.ts`,
added with Cut B). Everything else mocks its boundary (Neo4j / Redis+BullMQ / GitHub / GSM), so the
cross-component failures that have actually bitten us in prod are structurally invisible to the suite.
This roadmap (from a multi-agent deep-dive cross-referenced against `scars/` + `investigations/`)
prioritizes where real-dependency integration tests buy the most reliability.

## Prioritized gaps

| #   | Area                                                    | Key file(s)                                                                           | Pri    | Real dep            | Catches                                                                                                                                           | Scar                                                                             |
| --- | ------------------------------------------------------- | ------------------------------------------------------------------------------------- | ------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | **Neo4j DELETE migrations** (run every boot)            | `core-writer/src/neo4j/migrations.ts`                                                 | **P0** | Neo4j               | `DETACH DELETE` blast radius; Cypher `=~` vs JS-regex anchoring divergence; over-broad `.*[A-Z].*` Person regex nuking live data                  | person-canonical-id-login-case; canonical-id-org-namespacing                     |
| 2   | **BullMQ producer→consumer round trip**                 | `event-bus/src/bullmq/producer.ts`; `core-writer/main.ts`                             | **P0** | Redis+BullMQ        | colon-in-job-id **synchronous throw** (mock hides it); real retention trim (OOM); events stuck in `wait` with no consumer                         | bullmq-5-forbids-colons; redis-oom; core-writer-own-process                      |
| 3   | **Sync scheduler Queue + NoopRunner fallback**          | `api-server/src/services/sync-scheduler.ts`; `index.ts` wiring                        | **P0** | Redis+BullMQ        | real `new Queue(name)` colon throw; the silent `catch→NoopRunner` "stuck syncing forever" degradation                                             | bullmq-5-forbids-colons                                                          |
| 4   | **Webhook dedup↔enqueue↔redelivery**                    | `api-server/.../webhook-refetch-queue.ts`; `routes/webhooks.ts`                       | **P1** | Redis+BullMQ        | real SETNX-NX→DEL→redelivery-within-TTL; per-App secret mtime-cache rotation                                                                      | dedup-token-before-failable-side-effect                                          |
| 5   | **GSM store + boot hydration**                          | `api-server/src/secrets/gsm-store.ts`; `hydrate.ts`                                   | **P1** | GSM (real/emulator) | ADC/Workload-Identity; real gRPC PERMISSION_DENIED(7) wrong-IAM-tier; missing-vs-empty container; PEM byte fidelity                               | gsm-backed-login-allowlist; connector-apps-gsm-blob                              |
| 6   | **Neo4j linking-key / idempotency / claims round-trip** | `core-writer/src/neo4j/queries.ts`; `linking-key-index.ts`                            | **P1** | Neo4j               | MERGE fork w/o uniqueness constraint (NONE exist); `mergeEdge` silent no-op on missing endpoint; case-sensitive id lookup; lossless-Integer count | person-canonical-id-login-case                                                   |
| 7   | **api-server Neo4j read path**                          | `api-server/src/services/neo4j-service.ts` (APOC `getBlastRadius`); `team-service.ts` | **P1** | Neo4j+APOC          | APOC `subgraphAll` relationshipFilter correctness; `_`-label exclusion; OWNS vs CODEOWNER_OF traversal                                            | team-ownership-invisible-owns                                                    |
| 8   | **Manifest acceptance + forwarded-header callback**     | `github-app-manifest-service.ts`; `routes/connectors.ts`                              | **P2** | Fake GitHub         | request-time `readFileSync` ENOENT in image; `x-forwarded-host` branch; GitHub-side manifest rejects                                              | setup-wizard-manifest-enoent; first-login-redirect-uri; manifest-is-post-not-get |
| 9   | **Login behind real proxy / OIDC exchange**             | `server.ts` trustProxy; `services/auth/oidc-provider.ts` (untested)                   | **P2** | Fake IdP + proxy    | prod forced-secure cookie arm; SameSite; OIDC `exchange()`/PKCE; redirect_uri authorize↔exchange consistency                                      | login-loop-secure-cookie-trustproxy; first-login-redirect-uri                    |
| 10  | **Redis connector-run store**                           | `api-server/src/services/connector-run-store.ts`                                      | **P2** | Redis               | LPUSH/LTRIM FIFO cap; pipeline tuple parsing; `listManyLatest` batching (Redis impl has ZERO tests)                                               | connector-run-storage-redis-not-yaml                                             |

## NOT worth an integration test (good unit coverage / pure logic)

config loader, token-crypto, claims resolver/strategies, HMAC math (`auth/github-webhook.ts`),
string-similarity, confidence, `shouldEnterSetupMode`, `public-base-url`. Two **cheap unit** follow-ups
instead: `shared/.../find-root.ts` (SHIPIT_CONFIG missing/walk-up) and `core-writer/.../queries.ts`
`sanitizeLabel`/`sanitizeProperties` (zero coverage; `sanitizeLabel` output is interpolated into Cypher).

## Sequencing

- **Wave A — Neo4j (reuse the Cut B harness):** #1 FIRST (P0, destructive, runs every boot), then #6, #7.
- **Wave B — one Redis+BullMQ harness unlocks four:** #2, #3, #10, #4. #2/#3 must do a _real_ `new Queue(name)`
  to catch the colon throw (fires before connecting).
- **Wave C — GSM (#5):** real GCP project/emulator, env-gated like the Neo4j test.
- **Wave D — fake GitHub/IdP (#8, #9):** stub HTTP server for manifest acceptance + OIDC exchange.

## Status

Roadmap only. Wave A/#1 is the recommended next build (highest data-loss risk; reuses the existing
Neo4j integration harness + CI `integration` job). Each wave gets gated behind its env flag so the
default unit run stays Docker-free.

## Related

- [cutb-content-freshness-impl](../status/cutb-content-freshness-impl.md) — the first integration test + CI `integration` job
- [bullmq-5-forbids-colons-in-queue-names-and-job-ids](../scars/bullmq-5-forbids-colons-in-queue-names-and-job-ids.md)
- [redis-memory-limit-below-dataset-oomkills](../scars/redis-memory-limit-below-dataset-oomkills.md)
- [person-canonical-id-login-case-mismatch](../investigations/person-canonical-id-login-case-mismatch.md)
- [team-ownership-invisible-owns-and-blast-radius](../investigations/team-ownership-invisible-owns-and-blast-radius.md)
