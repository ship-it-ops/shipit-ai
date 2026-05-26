---
type: status
status: active
created: 2026-05-24
updated: 2026-05-24
author: claude-opus-4-7
branch: integrations
agent: dependabot-resolution
tags: [dependabot, security, pnpm, post-merge]
importance: standard
---

# In flight — Dependabot upgrade lands locally; PR + alert dismissals pending

## What landed (uncommitted on `integrations` branch)

All edits below are uncommitted in the working tree as of this status entry:

- `package.json` — `turbo: ^2.9.14` + new `pnpm.overrides` block (16 entries) for hono, @hono/node-server, express-rate-limit, fast-uri, vite, picomatch, flatted, path-to-regexp, brace-expansion@1, brace-expansion@5, qs, ip-address, postcss, yaml, ws, uuid.
- `packages/api-server/package.json` — `yaml: ^2.8.3`.
- `packages/shared/package.json` — `yaml: ^2.8.3`.
- `packages/web-ui/package.json` — `yaml: ^2.8.3`, `postcss: ^8.5.10`.
- `packages/mcp-server/package.json` — `@modelcontextprotocol/sdk: ^1.29.0`.
- `pnpm-lock.yaml` — regenerated.
- `docs/agent/decisions/dependabot-resolution-strategy.md` — captures the strategy, alternatives, and revisit triggers.
- `docs/agent/MANIFEST.md` — bumped.

Verified locally: `pnpm turbo typecheck` 14/14 green, `pnpm turbo test` 14/14 green (352-test baseline), live sync returns `status: success, entitiesSynced: 29`.

## What's still pending

1. **Commit + push** the changes so Dependabot rescans the lockfile. This is what auto-closes the alerts.
2. **Manually dismiss the 6 Fastify v5-only Dependabot alerts** (#1, #2, #3, #12, #13, #24) once the rescan settles. Rationale to paste: "Not applicable — on Fastify 4.29.1 line; upstream has issued no v4 backport for these advisories. GHSA descriptions reference v5-specific code paths (`reply.send(ReadableStream)` for GHSA-mrq3-vjjr-p77c, v5 schema validation pipeline for GHSA-jx2c-rxcm-jvmq, v5 trustProxy getter behavior for GHSA-444r-cwp2-x5xf). See `docs/agent/decisions/dependabot-resolution-strategy.md`."
3. **Open a follow-up issue** to migrate Fastify v4 → v5 in a dedicated PR, with route-by-route review. Once on v5, remove the dismissals.

## Quick verifier for the next agent

```bash
gh api '/repos/ship-it-ops/ShipIt-AI/dependabot/alerts?state=open&per_page=100' | jq 'length'
# Expect: 6 (the Fastify v5 ones) until dismissed, then 0.
```

If the count doesn't drop after push, check:

- Dependabot rescan completed (may take a few minutes after push)
- The override actually applied to the lockfile — `grep -E "^  ['\"]?<pkg>@" pnpm-lock.yaml` should show the patched version
- `pnpm audit --json` agrees with what Dependabot reports

## Status field

`active` until the PR lands and dismissals are processed. Archive then.
