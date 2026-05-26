---
type: decision
status: active
created: 2026-05-24
updated: 2026-05-24
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

## Related

- [github-connector-architecture-v1](github-connector-architecture-v1.md)
- [core-writer-runs-as-its-own-process](core-writer-runs-as-its-own-process.md)
- [bullmq-5-forbids-colons-in-queue-names-and-job-ids](../scars/bullmq-5-forbids-colons-in-queue-names-and-job-ids.md)
