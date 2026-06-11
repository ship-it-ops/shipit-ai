---
type: investigation
status: completed
created: 2026-06-10
updated: 2026-06-11
author: claude-session-2026-06-10
tags: [web-ui, dockerfile, build, pnpm, deploy]
---

# web-ui Dockerfile: `pnpm: not found` was the first of three stacked bugs

## Symptoms

Infra's `build-images.yml` failed on `build:web-ui` with
`/bin/sh: pnpm: not found` (exit 127). The cross-repo brief proposed a
one-line fix (move `corepack enable pnpm` to the `base` stage). Applying
it surfaced two more failures locally.

## Root Cause

Three independent bugs in `packages/web-ui/Dockerfile`, each masked by
the one before it:

1. **corepack only in `deps` stage** — `corepack enable` doesn't carry
   across `FROM` stages; `builder` ran `pnpm run build` without pnpm on
   PATH. (The brief's finding — correct but not sufficient.)
2. **`deps` stage installed with only the root `package.json`** — pnpm
   saw zero workspace packages, so it installed only root devDeps
   (turbo etc.) and none of web-ui's dependencies. `COPY . .` then
   papered over this locally by copying the host's macOS `node_modules`
   into the alpine image (no `.dockerignore` existed), which failed with
   `Cannot find module '@tailwindcss/oxide-linux-arm64-musl'` — a
   darwin-arm64 install inside a linux-musl container. In CI (clean
   checkout) it would instead fail with missing modules outright.
3. **Runner-stage paths assumed a single-package repo** — with
   `output: 'standalone'` in a pnpm monorepo, Next emits
   `.next/standalone/packages/web-ui/server.js`, not `/app/server.js`.
   The old `COPY --from=builder /app/public` / `/app/.next/standalone`
   paths and `CMD ["node", "server.js"]` could never have worked.

## Fix

- Rewrote `packages/web-ui/Dockerfile` on the api-server pattern: copy
  root manifests + `shipit.config.yaml` (required at build time by
  `next.config.mjs`) + the workspace closure (shared → mcp-server →
  web-ui), then `pnpm install --frozen-lockfile`, then
  `pnpm turbo build --filter=@shipit-ai/web-ui`. Runner copies the
  standalone tree and runs `node packages/web-ui/server.js`.
- Added root `.dockerignore` (`node_modules`, `.next`, `dist`, `.turbo`,
  `*.tsbuildinfo`, `shipit.config.local.yaml`, `.env*`, `.git`, logs).

## Prevention

See [[docker-copy-of-host-artifacts-poisons-image-builds]] — the scar
covering the `.dockerignore`/tsbuildinfo class of failure. Verified all
four images build with the new `.dockerignore`; web-ui runner smoke-
tested (HTTP 200 on /login).

## Related

- [image-build-owned-by-infra-repo](../decisions/image-build-owned-by-infra-repo.md) — why CI builds these images
- [docker-copy-of-host-artifacts-poisons-image-builds](../scars/docker-copy-of-host-artifacts-poisons-image-builds.md)
