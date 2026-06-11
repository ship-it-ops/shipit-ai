---
type: investigation
status: completed
created: 2026-06-11
updated: 2026-06-11
author: claude-session-2026-06-10
tags: [docker, pnpm, runtime, deploy, mcp-server]
---

# Backend images crashed at runtime: root node_modules copy defeats pnpm resolution

## Symptoms

mcp-server crashloops on GKE with `ERR_MODULE_NOT_FOUND: Cannot find
package '@modelcontextprotocol/sdk' imported from /app/dist/index.js`.
api-server and core-writer carried the identical latent bug (images
built fine; never scheduled before the fix).

## Root Cause

The runtime stage of all three backend Dockerfiles copied only the
**root** `node_modules` next to the package's `dist/`. pnpm keeps real
packages in the `.pnpm` virtual store and gives each workspace package
its own `packages/<pkg>/node_modules/` of symlinks into it — nothing is
hoisted to `node_modules/@scope/...` at the root. Node's resolver,
walking up from `/app/dist`, finds an empty shell. Workspace deps
(`@shipit-ai/shared` et al., symlinked to `/app/packages/*`) were
missing too.

Diagnosed on-cluster by infra; see the infra repo's
`deploy-run2-cpu-dockerfiles-node-sa` investigation.

## Fix

`pnpm --filter=<pkg> deploy --legacy --prod /out` in the builder stage
of each Dockerfile (api-server / core-writer / mcp-server): produces a
self-contained directory — package contents incl. `dist/` plus real,
de-symlinked production `node_modules` with workspace deps resolved.
Runtime stage is now just `COPY --from=builder /out ./`. The `--legacy`
flag is required on pnpm 10 (the non-legacy default wants
`inject-workspace-packages=true`). web-ui was never affected (Next.js
standalone output bundles its own pruned node_modules).

Verified per image: external + workspace imports resolve inside the
container, and `node dist/index.js` reaches the config-loading stage
(fails only on missing `shipit.config.yaml`, which infra provides
in-cluster).

## Prevention

Treat "image builds" and "image boots" as separate gates: smoke-run
every new image (`node dist/index.js` or an import probe) before
handing it to deploy. Sibling of the build-time stack in
[[web-ui-dockerfile-three-layered-build-failure]].

## Related

- [web-ui-dockerfile-three-layered-build-failure](web-ui-dockerfile-three-layered-build-failure.md)
- [docker-copy-of-host-artifacts-poisons-image-builds](../scars/docker-copy-of-host-artifacts-poisons-image-builds.md)
- [image-build-owned-by-infra-repo](../decisions/image-build-owned-by-infra-repo.md)
