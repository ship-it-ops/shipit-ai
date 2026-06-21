---
type: plan
status: completed
created: 2026-06-19
updated: 2026-06-20
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
done instead (2026-06-20): `shared/src/__tests__/find-root.test.ts` (5 — SHIPIT_CONFIG override +
walk-up + throw) and `core-writer/src/__tests__/queries.test.ts` (10 — `sanitizeLabel`/
`sanitizeProperties`, both now `export`ed; locks the Cypher-label whitelist).

## Sequencing

- **Wave A — Neo4j (reuse the Cut B harness):** #1 FIRST (P0, destructive, runs every boot), then #6, #7.
- **Wave B — one Redis+BullMQ harness unlocks four:** #2, #3, #10, #4. #2/#3 must do a _real_ `new Queue(name)`
  to catch the colon throw (fires before connecting).
- **Wave C — GSM (#5):** real GCP project/emulator, env-gated like the Neo4j test.
- **Wave D — fake GitHub/IdP (#8, #9):** stub HTTP server for manifest acceptance + OIDC exchange.

## Status

- **Wave A — DONE** (2026-06-19), all in the CI `integration` job:
  - **#1 Neo4j DELETE migrations** — `core-writer/migrations.integration.test.ts` (6): blast radius,
    DETACH-DELETE relationship handling, `_LinkingKey`/`_IdempotencyLog` old-vs-new, idempotent rerun,
    Person prefix-guard.
  - **#6 Neo4j storage round-trip** — `core-writer/neo4j-storage.integration.test.ts` (7): linking-key
    register/lookup MERGE-upsert + case sensitivity, `mergeEdge` SILENT no-op on a missing endpoint,
    `_claims` JSON round-trip, idempotency record/isDuplicate + `cleanupExpired` lossless-Integer count.
  - **#7 api-server APOC read path** — `api-server/neo4j-service.integration.test.ts` (5): `getBlastRadius`
    APOC traversal incl. the **CODEOWNER_OF** direction (the shipped ownership bug), `getGraphStats`/
    `getOverview`/`searchEntities` `_`-internal-label exclusion. CI Neo4j service gets `NEO4J_PLUGINS=["apoc"]`.
  - All validated against real Neo4j 5 + APOC 5.26 (20 core-writer + 5 api-server).
- **Wave B (Redis+BullMQ) — mostly DONE** (2026-06-19), in the CI `integration` job (added a `redis:7`
  service + `REDIS_TEST_URL`):
  - **#2 event-bus round trip** — `event-bus/event-bus.integration.test.ts` (2): real producer→BullMQ→
    consumer delivery of a colon-laden `shipit://` id (proves the `:`→`~` rewrite against real BullMQ);
    real `new Queue('a:b:c')` throws (the colon scar itself).
  - **#10 RedisConnectorRunStore** — `api-server/connector-run-store.integration.test.ts` (4): LPUSH/LTRIM
    FIFO cap, limit, `listManyLatest` pipeline tuple parsing, clear.
  - **#4 webhook delivery-dedup** — `api-server/webhook-refetch-dedup.integration.test.ts` (3): real SET-NX
    once-true-then-false, `releaseDelivery` DEL re-opens it, last-verified record/read round trip.
  - Validated against real Redis 7 (event-bus 2 + api-server 7).
  - **#3 sync-scheduler NoopRunner boot-degradation — DONE** (2026-06-20): extracted the inline
    `index.ts` scheduler wiring into a testable `services/sync-runtime.ts` (`wireSyncRuntime`), then
    tested the silent-degradation seam. `sync-runtime.test.ts` (4, unit, no Redis): happy-path routes a
    triggered sync to the live scheduler; a scheduler-construction throw keeps the API up AND reports
    `degraded:true` + warns (loud, not silent) with the registry left on its inert NoopRunner; a LATER
    resource throw doesn't swap the runner and releases what already constructed; no-Redis disables syncs
    without degrading. `sync-runtime.integration.test.ts` (2, REDIS_TEST_URL): a REAL `new Queue('a:b:c')`
    colon throw is caught → degraded (a mock can't catch this); happy path stands up scheduler+webhook+bus
    against real Redis and a triggered sync really enqueues. Refactor also fixed a latent partial-init bug:
    the runner is now swapped only after all three resources construct (was: registry pointed at a
    half-initialized scheduler if webhook-queue construction threw). Validated against real Redis 7.
- **Wave C — GSM (#5) — DONE** (2026-06-20), validated against real GCP `ship-it-ai-portal`; **NOT
  CI-enforced** (CI has no GCP creds) — local-opt-in, gated on `GSM_TEST_PROJECT` + ADC:
  - **#5 GSM store** — `api-server/src/__tests__/secrets/gsm-store.integration.test.ts` (5): real
    `accessSecretVersion` happy read + latest-of-many; real grpc **NOT_FOUND (code 5)** → null for both
    a versionless container AND an absent container (the value the unit suite could only fake); multiline
    PEM byte-for-byte through the store's own write→read path.
  - **#5 boot hydration** — `hydrate.integration.test.ts` (3): real GSM read → env populated + PEM
    materialized to disk (exact bytes, `0o600`, `github-app-<id>.pem`); operator pre-set env wins
    (no-clobber); empty-string env treated as unset and filled.
  - Run: `GSM_TEST_PROJECT=ship-it-ai-portal pnpm --filter @shipit-ai/api-server run test:integration`
    (needs `gcloud auth application-default login`). Throwaway `shipit-itest-<pid>-*` containers created
    via the raw admin client and DELETED in `afterAll` (verified 0 strays, robust even on failure).
  - **Findings:** real GCM **rejects empty payloads** (`INVALID_ARGUMENT: Secret Payload cannot be
empty`), so the store's `text.length > 0 ? : null` branch is UNREACHABLE from real GSM — kept as
    defensive code, locked by a synthetic-payload unit test. **PERMISSION_DENIED (code 7)** stays
    unit-only — unexercisable with self-owned throwaway secrets. The live RPCs occasionally flake on a
    gRPC deadline; just re-run (no retry logic added, since local-opt-in).
- **Wave D — fake GitHub/IdP (#8 + #9) — DONE** (2026-06-20), runs in the DEFAULT unit suite (no real
  dep — CI-enforced):
  - **#8 manifest acceptance + forwarded-header callback** — the manifest exchange/persist path was
    already well covered; this filled the three named gaps: `buildManifest` now wraps a request-time
    template-read failure in a CLEAR error naming the path + `SHIPIT_GITHUB_APP_MANIFEST_TEMPLATE`
    override (was a raw ENOENT → cryptic 500; the setup-wizard-manifest-launch scar) — locked by a test;
    `github-app-manifest-service.test.ts` also adds buildManifest URL substitution + the conversion POST
    shape (POST to `api.github.com/app-manifests/<code>/conversions` with the GitHub API headers) + a
    non-2xx rejection surfacing `HTTP 422`; `connectors.test.ts` adds the **x-forwarded-host** case —
    the callback derives from `x-forwarded-host` over the internal `Host` (the proxy redirect_uri 404
    failure mode). Small production change: the buildManifest read-error wrap.
  - **#9 OIDC exchange/PKCE** — `api-server/src/__tests__/services/auth/oidc-provider.test.ts` (8):
    drives the REAL `OidcProvider` (openid-client v6) against a `vi.stubGlobal('fetch')` IdP — discovery,
    token, userinfo, jwks — with a Node-crypto RS256-signed id_token (no `jose` dep, no server, no
    HTTPS). Covers `startAuthorization` (PKCE S256 challenge, distinct state/verifier per call,
    redirect_uri), `exchange` PKCE round trip (asserts the token request carried code + `code_verifier`
    - the SAME `redirect_uri` as authorize — the first-login redirect_uri scar), state-mismatch reject,
      wrong-`aud` reject, expired-id_token reject, userinfo-missing-email error, name→email displayName
      fallback.
  - **Finding:** openid-client does NOT verify the id_token SIGNATURE for the direct authorization-code
    token call (OIDC Core §3.1.3.7 — the TLS channel is trusted); it enforces the CLAIMS (iss/aud/exp/
    iat) + state. So a "tampered signature" test is moot; the sad paths target claims instead.
  - **#9 cookie/proxy half was ALREADY DONE** — the trustProxy forced-secure-cookie login-loop is
    covered in `routes/auth.test.ts` ("secure session cookie behind a TLS-terminating proxy", both the
    fix and the silent failure mode). #9 is therefore fully closed.
- Env gating: Neo4j suites on `NEO4J_TEST_URI`, Redis suites on `REDIS_TEST_URL`, GSM suites on
  `GSM_TEST_PROJECT`; default `pnpm test` skips all real-dep suites (Docker/creds-free) but RUNS the
  OIDC suite (it's fetch-stubbed, no real dep). CI integration job provides Neo4j+APOC and Redis
  services; GSM is local-only (no CI creds).
- **Isolation rule (learned):** real-DB integration files MUST run serially — vitest parallelizes
  files and they clobber a shared DB. `core-writer test:integration` uses `--no-file-parallelism`;
  any new wave sharing a backend must do the same or isolate per-DB. See
  [scar](../scars/integration-tests-sharing-a-db-must-run-serially.md).
- Each wave stays gated behind its env flag so the default unit run is Docker-free.

## Related

- [cutb-content-freshness-impl](../status/cutb-content-freshness-impl.md) — the first integration test + CI `integration` job
- [bullmq-5-forbids-colons-in-queue-names-and-job-ids](../scars/bullmq-5-forbids-colons-in-queue-names-and-job-ids.md)
- [redis-memory-limit-below-dataset-oomkills](../scars/redis-memory-limit-below-dataset-oomkills.md)
- [person-canonical-id-login-case-mismatch](../investigations/person-canonical-id-login-case-mismatch.md)
- [team-ownership-invisible-owns-and-blast-radius](../investigations/team-ownership-invisible-owns-and-blast-radius.md)
