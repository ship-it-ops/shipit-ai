---
type: scar
status: active
created: 2026-06-11
updated: 2026-06-11
author: claude-session-2026-06-10
incident-date: 2026-06-10
tripwire: 'if a Docker build fails differently locally vs CI, or tsc silently emits nothing, check what COPY drags in from the host: node_modules, dist, *.tsbuildinfo'
tags: [docker, build, tsc, pnpm, dockerignore]
importance: core
---

# Host build artifacts copied into Docker images cause platform and stale-emit failures

## What Happened

While fixing the web-ui image build, two host-artifact poisonings
surfaced in sequence:

1. With no `.dockerignore`, `COPY . .` copied the host's macOS
   `node_modules` into an alpine image → `Cannot find module
'@tailwindcss/oxide-linux-arm64-musl'`. The failure only reproduces
   on a dev machine — CI's clean checkout has no `node_modules` — so
   local and CI fail in completely different ways.
2. After excluding `node_modules`/`dist`, builds STILL failed: every
   package's `tsconfig.tsbuildinfo` lives at the package root (because
   `composite: true`), got COPY'd in, and told in-image `tsc` that all
   outputs were fresh — so it skipped emitting `.d.ts`/`.js` even
   though `dist/` was empty. Downstream packages then failed with
   TS7016 "could not find a declaration file".

## Tripwire

If a Docker build fails differently locally vs CI, or an in-image `tsc`
run completes but produces missing/partial output — check what `COPY`
brought in from the host before debugging the toolchain.

## Why It Hurt

Blocked the v1 GKE deploy; the masked install bug meant the brief's
"one-line fix" was actually a three-bug stack, costing a full rebuild
cycle per layer peeled.

## Don't Do This

- Don't add a Dockerfile `COPY . .` (or `COPY packages/x/ ...`) in this
  repo without the root `.dockerignore` excluding `**/node_modules`,
  `**/dist`, `**/.next`, `**/.turbo`, `**/*.tsbuildinfo`, and local
  secret files (`shipit.config.local.yaml`, `.env*`).
- Don't treat a green local `docker build` as proof of a green CI build
  (or vice versa) when the context may include host artifacts.

## Related

- [web-ui-dockerfile-three-layered-build-failure](../investigations/web-ui-dockerfile-three-layered-build-failure.md)
