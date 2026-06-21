---
type: scar
status: active
created: 2026-06-07
updated: 2026-06-07
author: claude-opus-4-7
tags: [pnpm, vitest, types-node, dependabot, tsc]
importance: core
incident-date: 2026-06-07
tripwire: "if pnpm install bumps vitest 3 -> 4 and tsc starts erroring `Cannot find namespace 'NodeJS'` / `Cannot find name 'node:fs'` in workspace packages that DON'T declare @types/node, stop and add @types/node devDep to those workspaces before debugging anything else"
---

# Bumping vitest 3 → 4 silently breaks every workspace that relies on transitive @types/node hoisting

## What Happened

While aggregating Dependabot PRs onto `dependabot-prs` (2026-06-07), the vitest 3 → 4 bump (PRs #34/#35/#36/#47) caused `pnpm turbo typecheck` to fail in `packages/shared` with:

```
src/__tests__/config-loader.test.ts(2,52): error TS2591: Cannot find name 'node:fs'.
src/config/loader.ts(9,9): error TS2503: Cannot find namespace 'NodeJS'.
src/config/loader.ts(13,30): error TS2591: Cannot find name 'process'.
```

…even though pre-bump `pnpm turbo typecheck` was 14/14 green on the same code.

The failure cascaded across every workspace whose `package.json` does NOT declare `@types/node` directly but whose source uses Node APIs (`node:fs`, `node:path`, `process`, `NodeJS.*`): `shared`, `event-bus`, `core-writer`, `api-server`, `mcp-server`. None of those had `@types/node` listed in their devDependencies — they were silently relying on it being hoisted into a position TypeScript could discover.

The `@types/node` 22 → 25 bump (PR #43) caused the same symptom for a related-but-different reason in the same install. Reverting `@types/node` alone did NOT fix the build; only also reverting vitest to ^3 restored it.

## Tripwire

**Two diagnostic signals to look for, together:**

1. `pnpm install` finished cleanly with NO source code changes since the last green build.
2. `tsc` (via `pnpm turbo typecheck` or any workspace's `pnpm build`) now reports `Cannot find namespace 'NodeJS'`, `Cannot find name 'node:fs'`, `Cannot find name 'node:path'`, `Cannot find name 'process'`, or `Cannot find namespace 'NodeJS'` in files that are clearly TypeScript-correct.

If you see both, **stop**. Do not start editing `tsconfig.base.json`'s `types`/`typeRoots`, do not start adding `/// <reference types="node" />` triple-slash directives, do not bisect random other deps. Check `git diff package.json pnpm-lock.yaml` for a vitest major bump or an `@types/node` major bump. The fix below is the right one.

## Why It Hurt

- Cost ~45 minutes of bisecting on the 2026-06-07 aggregation: reverting `@types/node` alone, then reverting vitest, then re-applying just vitest, then trying to add `@types/node` to `shared` explicitly to confirm the hypothesis.
- Forced deferring 5 Dependabot PRs from the aggregation (the four vitest 4 PRs and the @types/node 25 PR) when those bumps themselves were code-correct.
- The error message is deeply misleading — TypeScript blames missing `@types/node`, but `@types/node` IS installed (`pnpm why @types/node` confirms it, and it's even present at `node_modules/@types/node`). The fault is in TS's automatic-types discovery walking the wrong `node_modules` tree under pnpm 10's strict isolation.

## Don't Do This

- Don't accept a vitest major bump (or a coordinated `@types/node` major) as part of a "no source code changes needed" Dependabot aggregation. **Vitest majors and `@types/node` majors must come with explicit `@types/node` devDependency additions to every workspace that uses Node APIs.**
- Don't try to "fix" by setting `typeRoots: ["../../node_modules/@types"]` in `tsconfig.base.json`. It papers over the real issue (undeclared deps) and breaks pnpm's package-isolation model.
- Don't add `@types/node` to `dependencies` (only `devDependencies`) — these are TypeScript types only, no runtime cost.

## Fix

When you next bump vitest or `@types/node`, in the same PR add `"@types/node": "^22.0.0"` (or whatever version matches root) to the `devDependencies` of each workspace that uses Node APIs:

```bash
# Find which workspaces need it:
for pkg in shared event-bus connector-sdk core-writer api-server mcp-server connectors/github connectors/kubernetes; do
  count=$(grep -lE "node:(fs|path|os|crypto|stream|url|http|child_process)|NodeJS\.|process\." packages/$pkg/src/**/*.ts packages/$pkg/src/*.ts 2>/dev/null | wc -l)
  echo "$pkg: $count files use node APIs"
done
```

As of 2026-06-07 the affected workspaces are: `shared` (6 files), `event-bus` (1), `core-writer` (6), `api-server` (21), `mcp-server` (3). Re-run the grep before the PR; new files using node APIs may have appeared.

Then verify with `pnpm install && pnpm turbo typecheck && pnpm turbo test --force && pnpm turbo build`.

> **2026-06-20 update — this fix recipe NO LONGER HOLDS at `vitest@4.1.9` + TypeScript `6.0.3`.**
> Re-attempting the vitest 3→4 bump on `next-release` and adding `@types/node` to every Node-API
> workspace (shared, event-bus, core-writer, api-server, mcp-server, connectors/github) did NOT
> restore typecheck — `shared` still failed with `Cannot find namespace 'NodeJS'` / `Cannot find name
'node:fs'` in both src and test files, with `@types/node` correctly symlinked into the workspace at
> BOTH 22 and 25. So vitest 4 remains deferred (see the 2026-06-20 round in
> [dependabot-resolution-strategy](../decisions/dependabot-resolution-strategy.md)). Key relief valve:
> **vitest carries no security advisory** — the vulnerable transitive is `vite`, which we override
> independently — so staying on `vitest@3` costs nothing on security. A real vitest-4 adoption now
> needs a dedicated investigation into vitest-4 type resolution under pnpm-10 + TS-6, not this recipe.

## Related

- [dependabot-resolution-strategy](../decisions/dependabot-resolution-strategy.md) — the 2026-06-07 update lists this scar as a deferral reason
- [bullmq-5-forbids-colons-in-queue-names-and-job-ids](bullmq-5-forbids-colons-in-queue-names-and-job-ids.md) — sibling scar from the same dep-bump territory
