---
type: investigation
status: fixed
created: 2026-06-26
updated: 2026-06-26
author: claude-session-2026-06-26
tags: [vitest, pnpm, types-node, dependabot, testing, zod, plugin-react]
importance: core
---

# Vitest 3 → 4 migration — every breaking change and its fix

Done on `release-next` (PR #88), folding Dependabot #47. Five distinct v4 breaks,
each non-obvious. Recorded so the next major bump doesn't re-discover them.

## 1. `@types/node` automatic-types discovery breaks (the scar)

`tsc --noEmit` fails with `Cannot find name 'node:fs'`/`process`/`Buffer` in backend
workspaces; `tsc --noEmit --types node` returns 0 errors. → Fix: `"types": ["node"]`
in `tsconfig.base.json` + `@types/node` devDep in each backend workspace. The `types`
field is load-bearing; the devDep alone does NOT fix it. See
[[pnpm-implicit-types-node-hoisting-breaks-on-vitest-4]].

## 2. Workspace model removed

`defineWorkspace` / `vitest.workspace.ts` are gone. Replaced with root
`vitest.config.ts` using `test.projects: [...dirs, {inline}]`. **Gotcha:** v4 walks
_up_ to find a config, so a per-package `vitest run` finds the root `projects` config
and tries to resolve `packages/x/packages/x`. Fix: every package needs its own local
`vitest.config.ts` (added minimal ones to the 5 previously config-less packages).

## 3. `dist` no longer excluded by default

v4's default `exclude` is just `node_modules`/`.git` (v3 included `dist`). Since every
package compiles tests into `dist/`, vitest double-collected the stale compiled copies.
Fix: scope each config's `include` to `['src/**/*.test.ts']`. (Do NOT fix via tsconfig
exclude — that would also drop tests from typecheck, since build + `tsc --noEmit` share
the config.)

## 4. Arrow mock impls are not constructable

`vi.fn().mockImplementation(() => ({...}))` used with `new` throws "is not a
constructor" (v4 only treats `function`/`class` impls as constructable). Hit every
bullmq `Queue`/`Worker` and ioredis `Redis` mock (event-bus, webhook-refetch-queue,
sync-scheduler, audit-retention-scheduler). Fix: convert to `function () { return {...} }`.

## 5. `vi.spyOn` re-spy keeps call history + Mock typing

- Re-`vi.spyOn`-ing an already-spied method returns the existing spy WITH its history
  in v4 (v3 effectively reset). A "not called" assertion leaked prior tests' calls →
  add per-test `vi.restoreAllMocks()`.
- `vi.fn()` returns a loose `Mock<Procedure|Constructable>` no longer assignable to a
  specific signature. Type explicitly: `vi.fn<(code:number)=>void>()` /
  `Mock<...>` / cast the fake (`as unknown as ConnectorRunner`).

## Adjacent

- `@vitejs/plugin-react` went to **5.2.0, not 6** — v6 requires Vite 8; we're on Vite 7
  (Dependabot #46 stays open until a Vite 8 bump). plugin-react 5 was also required for
  vitest 4 + Vite 7 in web-ui.
- zod 3 → 4 landed in the same PR (separate commit); see
  [[connector-name-double-type-prefix]] is unrelated — zod notes are in commit 002c529.

## Related

- [pnpm-implicit-types-node-hoisting-breaks-on-vitest-4](../scars/pnpm-implicit-types-node-hoisting-breaks-on-vitest-4.md)
- [dependabot-resolution-strategy](../decisions/dependabot-resolution-strategy.md)
