---
type: status
status: active
created: 2026-06-10
updated: 2026-06-11
author: claude-session-2026-06-10
branch: main
agent: claude-session-2026-06-10
tags: [web-ui, dockerfile, build, deploy]
---

# Fixing web-ui Dockerfile `pnpm: not found` build failure

## Scope

Grew beyond the brief's one-liner: full rewrite of
`packages/web-ui/Dockerfile` (corepack in base, workspace-closure install,
monorepo standalone runner paths) plus a new root `.dockerignore`. See
[web-ui-dockerfile-three-layered-build-failure](../investigations/web-ui-dockerfile-three-layered-build-failure.md).
All four images verified building locally; web-ui runner smoke-tested.

## Why

Infra repo's `build-images.yml` fails on `build:web-ui` with
`/bin/sh: pnpm: not found` (exit 127). `corepack enable` does not carry
across Docker build stages. This is the only app-side blocker for the v1
GKE deploy. Cross-repo brief from infra dated 2026-06-10. Infra is fixing
a separate CI-auth (`token_format`) bug in the same workflow in parallel —
both must land before a build succeeds.

## Blocked on

User approval to commit and merge to `main` so infra can re-run
`build-images.yml` (infra's own `token_format` auth fix must also land).
