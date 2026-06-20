---
type: plan
status: active
created: 2026-06-19
updated: 2026-06-19
author: claude-session-2026-06-19-cutb-exec
branch: next-release
tags: [testing, integration-tests, handoff, gsm, oidc, manifest, scheduler, reliability]
importance: core
---

# HANDOFF: finish the integration-test roadmap (Wave C/D + #3)

You are picking up the integration-test reliability initiative. Waves A (Neo4j) and B
(Redis/BullMQ) are DONE and merged to `next-release`. This doc gives you everything to
finish the remaining items WITHOUT re-deriving the harness. Read the parent
[integration-test-coverage-roadmap](./integration-test-coverage-roadmap.md) first for the
full prioritized table and the scar mapping.

## What already exists (34 integration tests, all in the CI `integration` job)

- Neo4j seam: `core-writer/src/__tests__/{freshness-guard,migrations,neo4j-storage}.integration.test.ts`
  - `api-server/src/__tests__/services/neo4j-service.integration.test.ts` (APOC).
- Redis seam: `event-bus/src/__tests__/event-bus.integration.test.ts`
  - `api-server/src/__tests__/services/{connector-run-store,webhook-refetch-dedup}.integration.test.ts`.
- CI: `.github/workflows/ci.yml` → the `integration` job has a `neo4j:5` service
  (`NEO4J_PLUGINS=["apoc"]`) + a `redis:7` service, env `NEO4J_TEST_URI` / `REDIS_TEST_URL`,
  one step per package `test:integration`, runs on every PR/push, gates `claude-review`.

## THE RECIPE (copy this — do not reinvent)

1. **File:** `*.integration.test.ts` next to the unit tests. Wrap in
   `describe.skipIf(!process.env.<GATE>)(...)` so it SKIPS with no env (default `pnpm test`
   stays Docker-free). Gates: `NEO4J_TEST_URI`, `REDIS_TEST_URL`; define a NEW gate per new
   backend (e.g. `GSM_TEST_PROJECT`).
2. **Script:** each package needs `"test:integration": "vitest run .integration --no-file-parallelism"`.
   The `--no-file-parallelism` is MANDATORY — real-DB suites share one backend and clobber each
   other under vitest's parallel files (see scar
   [integration-tests-sharing-a-db-must-run-serially](../scars/integration-tests-sharing-a-db-must-run-serially.md)).
3. **Isolation:** unique id prefix per run (`itest-${process.pid}-${Math.floor(performance.now())}`)
   - clean up in `afterEach`. NEVER use `Date.now()`/`Math.random()` in workflow scripts (forbidden);
     `performance.now()` + pid is the pattern used everywhere here.
4. **CI:** add the package's `test:integration` as a step in the `integration` job. Add a service
   container (or env) for any new backend. For GSM there is no service container — gate on creds.
5. **VALIDATE LOCALLY before claiming done** — the harness mocks hide Cypher/Redis/gRPC reality.
   Spin a THROWAWAY container on a NON-default port so the user's running `docker-neo4j-1` /
   `docker-redis-1` (REAL DATA) are never touched:
   - Neo4j+APOC: `docker run -d --name shipit-itest-neo4j -e NEO4J_AUTH=neo4j/testpassword -e 'NEO4J_PLUGINS=["apoc"]' -p 7688:7687 neo4j:5`
     then `NEO4J_TEST_URI=bolt://localhost:7688 NEO4J_TEST_PASSWORD=testpassword pnpm --filter <pkg> run test:integration`
   - Redis: `docker run -d --name shipit-itest-redis -p 6380:6379 redis:7`
     then `REDIS_TEST_URL=redis://localhost:6380 pnpm --filter <pkg> run test:integration`
   - Wait-for-ready loop, run, then `docker rm -f <name>`.

## STANDING RULES (do not violate)

- **Never commit or push without explicit user approval** — ask for commit and push SEPARATELY each time.
- **No `Co-Authored-By` trailer** in commit messages.
- **Stage explicit file paths, never `git add <dir>`** — a directory add once swept a parallel agent's
  untracked status note into a commit. Check `git status` for sibling-agent WIP first.
- Restore `packages/web-ui/next-env.d.ts` before committing (a `next build`/dev run flips it; it's noise).
- Pre-commit runs prettier + secretlint; run `pnpm exec prettier --write` on new files first.

---

## Remaining items (purpose + how to build each)

### #5 — GSM secret store + boot hydration [P1] — ✅ DONE (2026-06-20)

**Shipped:** `api-server/src/__tests__/secrets/{gsm-store,hydrate}.integration.test.ts` (5+3), validated
against real GCP `ship-it-ai-portal`. Gated on `GSM_TEST_PROJECT` + ADC; **NOT CI-enforced** (no GCP
creds in CI). Throwaway `shipit-itest-*` containers via the raw admin client, deleted in `afterAll`.
Findings: real GCM rejects empty payloads (so the store's zero-length branch is unreachable, kept
defensive + unit-locked); PERMISSION_DENIED(7) stays unit-only (unexercisable with self-owned secrets);
live RPCs occasionally flake — just re-run. See the roadmap Wave C block. Original guidance below kept
for reference.

- **Purpose:** the api-server CRASHES on startup if it can't read secrets from Google Secret
  Manager. Unit tests fake the client with invented numeric codes, so the real gRPC contract is
  unverified. Maps to the run-6 `PERMISSION_DENIED` boot crash
  ([gsm-backed-login-allowlist](../decisions/gsm-backed-login-allowlist.md)) and
  [connector-apps-gsm-blob-durability](../decisions/connector-apps-gsm-blob-durability.md).
- **Files:** `api-server/src/secrets/gsm-store.ts` (ADC `SecretManagerServiceClient`, gRPC error
  codes), `secrets/hydrate.ts` (PEM 0o600 write), `secrets/types.ts`.
- **Real dep / gate:** a real GCP project OR the GSM emulator (limited — verify `accessSecretVersion`,
  `addSecretVersion` are supported; if not, use a real project's throwaway secrets). New env gate,
  e.g. `GSM_TEST_PROJECT`. CI: no service container — set the gate only on a job that has GCP creds,
  or keep it local/opt-in and document it as not-CI-enforced.
- **First tests:** read a present secret; wrong-IAM-tier read surfaces a RECOVERABLE error naming the
  container (NOT a crash); absent container vs empty container distinguished; multiline-PEM byte
  fidelity through write-then-read-latest.
- **Cost:** highest (real GCP/emulator). Worth it before the next cluster deploy.

### #3 — sync-scheduler `NoopRunner` boot-degradation [P0-ish] — ✅ DONE (2026-06-20)

**Shipped:** extracted the inline `index.ts` wiring (was ~L316-365) into `services/sync-runtime.ts`
(`wireSyncRuntime`) — a sync function defaulting to the real constructors but accepting injectable
factories + logger, returning `{ eventBus, scheduler, webhookRefetch, degraded }`. Tests:
`__tests__/services/sync-runtime.test.ts` (4 unit, no Redis) + `sync-runtime.integration.test.ts`
(2, gated `REDIS_TEST_URL`). The integration test does a REAL `new Queue('shipit:sync:github')` colon
throw through `wireSyncRuntime` and asserts it degrades to the NoopRunner (a mock can't catch this);
the happy path stands the scheduler+webhook+bus up against real Redis and proves a triggered sync
enqueues onto the live scheduler. Refactor also fixed a latent partial-init bug (runner swapped only
after all three resources construct; resources released on a mid-wiring throw). Validated against real
Redis 7. `degraded:true` is returned but NOT yet surfaced to a health endpoint — a future follow-up if
operators want a probe signal beyond the boot warning. Original guidance kept below.

- **Purpose:** if the scheduler can't build its BullMQ queue (e.g. a colon sneaks back into the queue
  name), the boot code swallows the error into a `NoopRunner` → connectors show "syncing…" forever,
  silently. Maps to [bullmq-5-forbids-colons](../scars/bullmq-5-forbids-colons-in-queue-names-and-job-ids.md).
  (The colon-throw HALF is already guarded by `event-bus.integration.test.ts`.)
- **Files:** `api-server/src/services/sync-scheduler.ts` (`DEFAULT_QUEUE`, `new Queue`),
  `api-server/src/index.ts` (~L324-365, the `catch → console.warn → NoopRunner` fallback).
- **Real dep:** Redis (for the happy path); the colon-throw needs only real BullMQ.
- **First tests:** a real `new Queue('shipit:sync:github', …)` throws synchronously; a boot-wiring test
  where a throwing scheduler construction leaves the registry on `NoopRunner` (loud, not silent). The
  hard part is exercising `index.ts` boot — consider a small extract of the wiring into a testable
  function, or a focused server-boot harness.
- **Cost:** low-medium.

### #9 — login behind real proxy / OIDC exchange [P2] — ✅ DONE (2026-06-20)

**Shipped:** `api-server/src/__tests__/services/auth/oidc-provider.test.ts` (8) — drives the REAL
`OidcProvider` (openid-client v6) against `vi.stubGlobal('fetch')` (discovery/token/userinfo/jwks)
with a Node-crypto RS256-signed id_token. No stub HTTP server, no HTTPS, no `jose` dep — openid-client
uses global fetch, so the github-provider.test.ts stub pattern works. Covers startAuthorization
(PKCE/state/redirect_uri), the exchange PKCE round trip (token request carries code + code_verifier +
matching redirect_uri), and sad paths (state mismatch, wrong aud, expired token, missing email claim).
Runs in the DEFAULT unit suite (CI-enforced — no real dep). **The cookie/proxy half was already done**
in `routes/auth.test.ts` (trustProxy forced-secure-cookie login-loop, both fix + failure mode), so #9
is fully closed. **Finding:** openid-client does NOT verify the id_token signature on the direct code-
flow token call (OIDC Core §3.1.3.7 — trusts the TLS channel); it enforces the claims (iss/aud/exp) +
state, which is what the sad paths target. Original guidance below.

- **Purpose:** "nobody can log in." The prod forced-secure-cookie + SameSite behind a TLS-terminating
  proxy (the bounce loop), and the OIDC `exchange()`/PKCE path which has NO real test (only an injected
  mock). Maps to [login-loop-secure-cookie-trustproxy](../investigations/login-loop-secure-cookie-trustproxy.md),
  [first-login-redirect-uri-and-missing-callback-urls](../investigations/first-login-redirect-uri-and-missing-callback-urls.md).
- **Files:** `api-server/src/server.ts` (trustProxy/secure cookie arm), `services/auth/oidc-provider.ts`
  (openid-client v6, untested), `services/auth/github-provider.ts`.
- **Real dep:** a stub OIDC/GitHub HTTP server stood up in-test (no external network); optionally a real
  proxy in front for the cookie test.
- **First tests:** OIDC `exchange()` PKCE round trip against the stub; `redirect_uri` consistency between
  authorize and exchange; prod-mode forced-secure cookie delivery.
- **Cost:** medium-high.

### #8 — GitHub App manifest acceptance + forwarded-header callbacks [P2] — ✅ DONE (2026-06-20)

**Shipped:** the exchange/persist path was already well covered; this filled the three named gaps.
`buildManifest` now wraps a request-time template-read failure in a CLEAR error (names the path +
`SHIPIT_GITHUB_APP_MANIFEST_TEMPLATE` override) instead of a raw ENOENT → cryptic 500 (small production
change). Tests: `github-app-manifest-service.test.ts` adds the ENOENT clear-error, buildManifest URL
substitution, the conversion POST shape (POST to `api.github.com/app-manifests/<code>/conversions` with
the GitHub API headers), and a non-2xx (`HTTP 422`) rejection; `connectors.test.ts` adds the
**x-forwarded-host over internal Host** callback derivation (the proxy redirect_uri 404 case). All in
the default unit suite (no real dep — a stub GitHub server wasn't needed; the mock-fetch seam suffices).
**This is the last roadmap item — all 10 prioritized gaps are now closed.** Original guidance below.

- **Purpose:** first-run setup-wizard breakage: manifest template `ENOENT` at request time in the built
  image; `x-forwarded-host` deriving a wrong callback URL; GitHub rejecting the manifest. Maps to
  [setup-wizard-manifest-launch-enoent](../investigations/setup-wizard-manifest-launch-enoent.md),
  [github-app-manifest-is-post-not-get](../scars/github-app-manifest-is-post-not-get.md),
  first-login-redirect-uri.
- **Files:** `api-server/src/services/github-app-manifest-service.ts`,
  `api-server/src/routes/connectors.ts` (`manifestUrlsFromRequest`).
- **Real dep:** a stub GitHub HTTP server; for ENOENT, simulate the template file absent at request time
  (not just `existsSync` in the repo).
- **First tests:** request-time file-absent → clear error (not a 500 with a cryptic ENOENT); the
  `x-forwarded-host` branch derives the right callback; manifest POST shape accepted by the stub.
- **Cost:** medium. Lowest priority (only matters during initial onboarding).

## Recommended order

~~**#5 GSM**~~ ✅ DONE → ~~**#3 NoopRunner**~~ ✅ DONE → ~~**#9 OIDC**~~ ✅ DONE → ~~**#8 manifest**~~
✅ DONE. **All 10 prioritized roadmap items are closed.** Only the two cheap UNIT follow-ups below
remain.

## Cheap UNIT follow-ups (NOT integration — deep-dive flagged)

- `shared/.../find-root.ts` — `SHIPIT_CONFIG` missing-file / walk-up (no test today).
- `core-writer/.../neo4j/queries.ts` — `sanitizeLabel`/`sanitizeProperties` (zero coverage;
  `sanitizeLabel` output is interpolated directly into Cypher → injection-shaped risk).

## Related

- [integration-test-coverage-roadmap](./integration-test-coverage-roadmap.md) — full table + scar mapping
- [integration-tests-sharing-a-db-must-run-serially](../scars/integration-tests-sharing-a-db-must-run-serially.md)
- [cutb-content-freshness-impl](../status/cutb-content-freshness-impl.md)
