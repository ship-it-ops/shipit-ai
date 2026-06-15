---
type: decision
status: active
created: 2026-05-24
updated: 2026-06-07
author: claude-opus-4-7
tags: [security, dependabot, pnpm, supply-chain]
importance: core
---

# Resolve Dependabot advisories with `pnpm.overrides` + direct dep bumps; defer Fastify v4→v5 migration

## Context

GitHub reported 43 open Dependabot alerts on the `integrations` branch (10 high, 30 medium, 3 low). The alerts spanned 4 directly-declared packages (`turbo`, `yaml`, `postcss`, `fastify`) and a long tail of transitives — most arriving through `@modelcontextprotocol/sdk` (hono, express, @hono/node-server, fast-uri via ajv), through `vitest` (vite, picomatch), or through deep utility chains (flatted, brace-expansion, path-to-regexp, qs, ip-address). `pnpm audit` surfaced two additional ones not yet flagged by Dependabot (`ws` via `@kubernetes/client-node`, `uuid` via `bullmq`).

The remediation needs to (a) close the alerts without breaking the dev-server pipeline (api-server + core-writer + mcp-server + web-ui), (b) keep the change reviewable in a single PR, and (c) avoid major framework migrations that would balloon scope.

## Decision

Three-layer strategy, applied in a single PR:

1. **Bump direct deps in each `package.json`** for advisories where the project declares the vulnerable package directly. Done for `turbo` (root), `yaml` (api-server, shared, web-ui), `postcss` (web-ui), and `@modelcontextprotocol/sdk` (mcp-server).
2. **Use `pnpm.overrides` in the root `package.json`** to force-upgrade every other vulnerable transitive to a patched version. For packages with parallel vulnerable major lines (e.g. `brace-expansion` v1 and v5 both have separate advisories), use the `name@range` key form so each line gets its own patched minimum.
3. **Defer Fastify v4 → v5 migration.** All 6 Fastify advisories patch in the v5 line only; no v4 backport has been shipped. The advisories' `vulnerable_version_range` strings (`< 5.7.2`, `<= 5.8.2`) mechanically include our `4.29.1`, but the GHSA descriptions reference v5-specific code paths (`reply.send(ReadableStream)`, the `trustProxy` getter behavior introduced in v5, the v5 schema-validation pipeline). Upstream's signal — no v4 patch — is that v4 is not affected. We dismiss the 6 Fastify Dependabot alerts as "not applicable: Fastify v4 line, upstream issued no v4 backport".

> **Superseded 2026-05-26 by [fastify-v5-migration](fastify-v5-migration.md).** The dismissal step was never executed. On the follow-up `fix-vulns` branch we actually performed the v4→v5 migration; turned out to be a 4-line `package.json` change (fastify + 3 plugins) with no source edits. Layers 1 and 2 of this decision remain in effect.

## Alternatives Considered

- **Pin every vulnerable transitive at the parent level by bumping the parent.** Rejected for most transitives: walking the parent chain for 30+ alerts would force majors on `vitest`, `secretlint`, etc. — much larger scope and more breakage risk than a single overrides block. We did bump `@modelcontextprotocol/sdk` to `^1.29.0` because that's a clean minor and pulled in fixed `hono`/`express-rate-limit`/`ajv` ranges; the overrides are then the safety net for whatever didn't land naturally.
- **Migrate Fastify to v5 now.** Rejected (this PR). v5 removed the implicit Content-Type body parser fallback, tightened schema validation, and renamed several route options. The api-server routes (`packages/api-server/src/routes/*.ts`) use `request.body`, ETag `If-Match` plumbing, and HTML `reply.type('text/html').send(...)` from the manifest endpoints — all of which need re-validation under v5. Worth its own scoped PR with route-by-route review.
- **Use `npm audit fix` / `pnpm audit fix`.** Rejected: pnpm doesn't have a true `audit fix`, and the equivalent in npm would walk the tree heuristically and frequently downgrades transitives in surprising ways. Explicit overrides are more auditable.

## Consequences

- The root `package.json` now carries an `"overrides"` block under `pnpm.*`. New direct deps that conflict with an override will fail `pnpm install` loudly — operators see the override and choose to either drop it or align the new dep with it. Drop an override once a parent bump covers the same transitive (anti-bloat).
- `brace-expansion` overrides use the `name@majorRange` form (`brace-expansion@1`, `brace-expansion@5`) because v1 and v5 have separate advisory ranges with separate patched minimums. Forcing all to one major would break callers pinned to the other.
- The 3 remaining `pnpm audit` advisories are all Fastify v5-only. Dismiss the 6 corresponding Dependabot alerts (#1, #2, #3, #12, #13, #24) with rationale "not applicable: on Fastify 4.x line, upstream issued no v4 patch — vulnerable code paths cited in the GHSAs are v5-specific."
- Reading `pnpm-lock.yaml` will show new override-metadata pseudo-entries (`brace-expansion@1: ^1.1.13`, etc.) above the resolved versions. These are markers pnpm leaves to record which overrides applied; they aren't installable packages.
- All 352 baseline tests still pass; the live api-server + core-writer pipeline still sync GitHub entities end-to-end with `status: success, entitiesSynced: 29`.

## Revisit Triggers

- **A new Fastify v5 patch lands AND we want the v5 features (improved schema, Web Streams response support).** Open a follow-up PR for the v4→v5 migration; remove the Dependabot dismissals once on v5.
- **MCP SDK bumps a transitive across a major** that the override pins below. Either bump the override or relax to the new range. Same for vite / picomatch / hono.
- **`pnpm audit` regularly surfaces non-Dependabot CVEs** (today: `ws` and `uuid`). Run `pnpm audit --json` quarterly alongside Dependabot rescans and add overrides as new advisories drop.
- **The override list grows past ~15 entries.** That's a smell — it usually means a parent (often vitest or an internal `@ship-it-ui/*` package) is stuck on a stale transitive. Bump the parent instead.

## Critical files touched

- `package.json` (root) — turbo bump, new `pnpm.overrides` block (16 entries).
- `packages/api-server/package.json` — `yaml: ^2.8.3`.
- `packages/shared/package.json` — `yaml: ^2.8.3`.
- `packages/web-ui/package.json` — `yaml: ^2.8.3`, `postcss: ^8.5.10`.
- `packages/mcp-server/package.json` — `@modelcontextprotocol/sdk: ^1.29.0`.
- `pnpm-lock.yaml` — regenerated by `pnpm install`.

## Verification

- `pnpm turbo typecheck` → 14/14 green.
- `pnpm turbo test` → 14/14 green (352-test baseline preserved).
- `pnpm audit` → 3 remaining advisories, all Fastify v5-only (intentionally deferred).
- Live `curl http://localhost:3001/api/health` → 200, uptime fresh.
- Live `POST /api/connectors/github-ship-it-ops/sync` → `status: success, entitiesSynced: 29, errors: []`.

## Update 2026-06-07 — second aggregation round (`dependabot-prs` branch)

Dependabot opened 14 fresh PRs after the auth/RBAC merge (PR #48). Aggregated 8 of them into one commit on local branch `dependabot-prs` (commit `3eac41b`); deferred 4 — not for risk reasons, for **real upstream blockers** that need their own scoped PRs to fix.

### Aggregated (auto-close on next rescan after push)

- **#37** docker/build-push-action v6 → v7 (CI workflow file only).
- **#38** dev-dependencies group: lint-staged 17.0.7, tsx 4.22.4, turbo 2.9.16, eslint-config-next 16.2.7, axe-core 4.12.0.
- **#39** production-patches group: bullmq 5.77.7, next 16.2.7, react/react-dom 19.2.7, zustand 5.0.14, seven @ship-it-ui/\* internal-design-system patches.
- **#41** @octokit/auth-app 7 → 8. Verified safe: v8's only documented break is dropping Node 18 (we're on Node 22). The `createAppAuth` strategy we pass to `Octokit({ authStrategy, auth: { appId, privateKey, installationId } })` in `packages/connectors/github/src/auth.ts` is unchanged at the API level.
- **#42** neo4j-driver 5 → 6. Verified by reading the v6 release notes vs. our call sites in `packages/core-writer/src/neo4j/client.ts`, `packages/api-server/src/services/{neo4j-service,cypher-query-service}.ts`, `packages/mcp-server/src/neo4j-client.ts`. The only v5→v6 removal we touch is `verifyConnectivity()` whose return type changed from `ServerInfo` to `void` — and we discard the return value at `core-writer/src/neo4j/client.ts:10`. We already use `session.executeRead/executeWrite` (the v6-replacement APIs); we never call `readTransaction`/`writeTransaction`/`lastBookmark`/`updateStatistics`.
- **#44** lucide-react 1.17.
- **#45** @tanstack/react-query 5.100.

`packages/web-ui/next-env.d.ts` auto-regenerated by Next 16.2.7 (route types path moved from `.next/dev/types/` to `.next/types/`); fine to commit.

### Deferred (each needs its own follow-up PR)

1. **#40 eslint 9 → 10.** `eslint-config-next` pulls in `eslint-plugin-react`, `eslint-plugin-jsx-a11y`, and `eslint-plugin-import`; all three call `scopeManager.addGlobals` which ESLint 10 removed. Reproduces immediately on `pnpm lint`. **Revisit when** those three plugins ship ESLint 10 support (track via `pnpm outdated` against the `next` group).

2. **#46 @vitejs/plugin-react 4 → 6.** Imports `vite/internal`, which is not in vite 7's `exports` map. v6 is built for vite 8. We're on vite 7 (pinned via the root pnpm override block). **Revisit when** we bump vite to 8 — likely needs to land in lockstep with vitest 4 since vitest's vite-peer also bumps.

3. **#43 @types/node 22 → 25 + #34/#35/#36/#47 vitest 3 → 4.** Same root cause — see [pnpm-implicit-types-node-hoisting-breaks-on-vitest-4](../scars/pnpm-implicit-types-node-hoisting-breaks-on-vitest-4.md). The cheap fix is to declare `@types/node` explicitly in the five workspaces that use Node APIs without depending on the root: `packages/{shared,event-bus,core-writer,api-server,mcp-server}/package.json`. Out of scope for a pure dep-bump aggregation. **Revisit by** opening one PR that adds those five `@types/node` devDependencies + bumps both vitest and @types/node together; verify with `pnpm turbo typecheck` after each step.

### Audit posture after this round

`pnpm audit` reports 2 critical advisories (GHSA-5xrq-8626-4rwp) — both on vitest <4.1.0. They only trigger when `vitest --ui` is listening on a port. We never run `--ui` in CI; the dev posture is "don't run `vitest --ui` on an untrusted network." Will close when the vitest 4 follow-up lands.

### Verification (2026-06-07 round)

- `pnpm turbo typecheck` → 14/14.
- `pnpm turbo test --force` → 14/14 (api-server 156 tests, etc.).
- `pnpm turbo build` → 9/9.
- `pnpm turbo lint` → 0 errors (17 pre-existing warnings).

### Critical files touched (this round)

- `.github/workflows/ci.yml` — `docker/build-push-action@v7`.
- `package.json` (root) — lint-staged, neo4j-driver, tsx, turbo.
- `packages/api-server/package.json` — bullmq, neo4j-driver.
- `packages/connectors/github/package.json` — @octokit/auth-app.
- `packages/core-writer/package.json` — neo4j-driver.
- `packages/event-bus/package.json` — bullmq.
- `packages/mcp-server/package.json` — neo4j-driver, tsx.
- `packages/web-ui/package.json` — next, react, react-dom, @tanstack/react-query, zustand, lucide-react, axe-core, eslint-config-next, 7× @ship-it-ui/\*.
- `packages/web-ui/next-env.d.ts` — auto-regenerated.
- `pnpm-lock.yaml`.

## Update 2026-06-14 — third round (on `more-prod-fixes`)

2 open Dependabot security alerts (both **esbuild** `< 0.28.1`, high + low, transitive via
vite/vitest/tsx) plus 6 open version-update PRs. Applied the safe set + the transitive
override directly on `more-prod-fixes` (layers 1+2 of this decision); deferred the same
upstream-blocked majors as the 2026-06-07 round.

### Applied

- **esbuild security (2 alerts):** added `"esbuild": "^0.28.1"` to the root `pnpm.overrides`
  (now 17 entries). `pnpm-lock.yaml` collapses to a single `esbuild@0.28.1`; `pnpm audit` →
  "No known vulnerabilities found".
- **#56 production-patches group:** `ioredis ^5.11.1` (root + api-server + event-bus),
  `next ^16.2.9` (web-ui), and the internal design-system bumps `@ship-it-ui/{ui 0.0.16,
shipit 0.0.17, icons 0.0.12, cytoscape 0.0.16, graph-editor 0.0.11, next 0.0.14}`.
- **#53 dev group:** `@types/react ^19.2.17` (web-ui).
- Also fixed a stale `setup/page.test.tsx` assertion left by the auth-OAuth-App change
  (`66bb8d7`) — it looked for the removed "Create GitHub App" button; now asserts the OAuth
  client id/secret form + mocks `postSetupOAuth`. (The auth commit shipped without running
  web-ui vitest; caught here by `turbo test`.)

### Deferred (unchanged blockers — see 2026-06-07 round + the vitest-4 scar)

- **#40 eslint 9→10**, **#43 @types/node 22→25**, **#46 @vitejs/plugin-react 4→6**,
  **#47 vitest 3→4.** Same real upstream blockers; each needs its own scoped PR. The
  @types/node + vitest-4 pair is the logical next one (declare `@types/node` in the five
  Node-using workspaces, then bump both together).

### Verification (this round)

- `pnpm turbo typecheck` → 14/14; `pnpm turbo test` → 14/14 (web-ui setup test fixed);
  `pnpm turbo build` → 9/9; `pnpm turbo lint` → 0 errors (18 pre-existing warnings);
  `pnpm audit` → clean.

### Critical files touched (this round)

- `package.json` (root) — `ioredis`, new `esbuild` override.
- `packages/api-server/package.json`, `packages/event-bus/package.json` — `ioredis`.
- `packages/web-ui/package.json` — `next`, `@types/react`, 6× `@ship-it-ui/*`.
- `packages/web-ui/src/app/(auth)/setup/page.test.tsx` — OAuth-form assertions.
- `pnpm-lock.yaml`.

## Related

- [github-connector-architecture-v1](github-connector-architecture-v1.md)
- [core-writer-runs-as-its-own-process](core-writer-runs-as-its-own-process.md)
- [bullmq-5-forbids-colons-in-queue-names-and-job-ids](../scars/bullmq-5-forbids-colons-in-queue-names-and-job-ids.md)
- [pnpm-implicit-types-node-hoisting-breaks-on-vitest-4](../scars/pnpm-implicit-types-node-hoisting-breaks-on-vitest-4.md)
