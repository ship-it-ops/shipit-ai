---
type: scar
status: active
created: 2026-09-16
updated: 2026-09-16
incident-date: 2026-09-16
author: claude-session-2026-09-16-ci-fixes
tripwire: "a service's Docker build fails in CI with TS6053 'File ... not found' or TS2307 'Cannot find module @shipit-ai/x' while `pnpm turbo build` is green locally — the Dockerfile's builder stage COPYs a fixed package list that no longer covers the package's closure, and `tsc` compiles its test files too"
tags: [docker, build, tsc, pnpm, workspace, devdependencies, ci]
importance: core
---

# A service Dockerfile's builder stage COPYs a fixed package set — adding a workspace dep silently breaks it

## What Happened

Task 12 gave core-writer an acceptance test
(`src/__tests__/acceptance/cross-source.integration.test.ts`) that imports
`@shipit-ai/connector-github` and `@shipit-ai/connector-kubernetes` as workspace
devDependencies, and added matching `references` entries to
`packages/core-writer/tsconfig.json`. Everything was green locally and in the
repo-wide `turbo build`, because the whole workspace is on disk there.

The Docker Build (core-writer) CI job failed:

```
packages/core-writer/tsconfig.json(11,5): error TS6053: File '/app/packages/connectors/github' not found.
packages/core-writer/tsconfig.json(12,5): error TS6053: File '/app/packages/connectors/kubernetes' not found.
```

The builder stage COPYs an explicit, hand-maintained list of workspace packages —
for core-writer that was only `shared`, `event-bus`, `core-writer`. Nothing
regenerates that list from the package's dependency graph, so a new workspace
dependency is invisible until the image build runs in CI.

Two things were wrong, and both had to be fixed:

1. The `references` pointed at directories the image never copies. api-server is
   the precedent: it depends on connector packages but references only `shared`
   and `event-bus` — types resolve through node_modules `exports`
   (`./dist/index.d.ts`), because turbo's `typecheck`/`build` depend on `^build`.
2. Even with the references removed, `tsc` still compiles every file matched by
   `include: ["src/**/*"]` — the acceptance test included — so the connector
   packages (and `connector-sdk`, which they depend on) genuinely must be present
   in the builder stage. They are added there and stripped again by
   `pnpm deploy --legacy --prod`, so the runtime image is unchanged.

## Tripwire

A service image build that fails in CI with `TS6053 File '...' not found` or
`TS2307 Cannot find module '@shipit-ai/...'`, while the same `turbo build` is
green locally → compare the Dockerfile's `COPY packages/...` lines against that
package's `dependencies` **and** `devDependencies`. Remember `tsc` compiles the
package's own tests, so a test-only workspace import is a builder-stage
requirement, not just a dev convenience.

## Why It Hurt

The failure is structurally invisible outside CI: the local workspace always has
every package, so nothing short of an actual `docker build` (or a faithful
simulation that copies only the COPY'd paths) reproduces it. It burned a full CI
round trip on a PR that was otherwise green, and the first fix attempt — dropping
the tsconfig `references` — is necessary but not sufficient on its own.

## Don't Do This

- Don't add a workspace dependency (including a **devDependency**, including one
  used only by tests) to a package that ships an image without updating that
  package's `Dockerfile` builder-stage COPY list — and the transitive workspace
  packages it pulls in (`connectors/*` need `connector-sdk`).
- Don't add a tsconfig `references` entry for a workspace package the image does
  not COPY. Follow `packages/api-server/tsconfig.json`: reference only `shared`
  and `event-bus`, and let types resolve through node_modules `exports`.
- Don't treat a green `pnpm turbo build` as evidence the image builds. Without a
  Docker daemon, simulate the builder stage — copy _only_ the COPY'd paths
  (`git ls-files`, so `dist/` and `node_modules/` never leak in), then
  `pnpm install --frozen-lockfile && pnpm turbo build --filter=<pkg>`.

## Second instance (2026-09-25, PR #115) — a TEST-ONLY import trips it too

Adding `@shipit-ai/mcp-server` as a **devDependency** of core-writer so its acceptance test
could call the real `generateBlastRadiusCypher` turned two CI jobs red at once, from one line:

- **Docker Build (core-writer)** — `error TS2307: Cannot find module
'@shipit-ai/mcp-server/cypher'`. The builder COPYs a fixed package set that does not include
  mcp-server, and `tsc` compiles `src/__tests__/**` during the image build (every package in
  this repo has `include: ["src/**/*"]` with no test exclusion — that is the convention, not an
  oversight).
- **Integration (Neo4j)** — `ERR_MODULE_NOT_FOUND`. That job runs
  `pnpm --filter … test:integration` **directly, not through turbo**, so no `^build` runs and no
  workspace `dist/` exists. Each package's `vitest.config.ts` carries an explicit alias list
  redirecting `@shipit-ai/*` to TS source; a package missing from that list falls through to node
  resolution and dies on the absent `dist/`.

So a new cross-package import has **three** places that must agree, not one: the Dockerfile COPY
list, the vitest alias list, and the lockfile. `pnpm build && pnpm test` locally exercises none
of the first two.

**The cheap way out:** put the shared thing in `@shipit-ai/shared`. Every service already depends
on it, every Dockerfile already COPYs it, and every vitest config already aliases it. That is how
this instance was fixed — the two blast-radius edge patterns moved to
`packages/shared/src/types/graph-edges.ts` and both sides import them from there, instead of
core-writer reaching into mcp-server.

## Related

- [docker-copy-of-host-artifacts-poisons-image-builds](docker-copy-of-host-artifacts-poisons-image-builds.md) — the other half of "what the COPY context contains"
- [backend-images-runtime-module-not-found](../investigations/backend-images-runtime-module-not-found.md) — why the prod bundle is `pnpm deploy`d rather than a node_modules copy
- `packages/api-server/Dockerfile` — the precedent: the full workspace closure COPY'd in dependency order, with the ordering comment this scar's fix mirrors
