---
type: investigation
status: completed
created: 2026-06-11
updated: 2026-06-11
author: claude-session-2026-06-11
branch: main
tags: [setup-mode, github-app-manifest, deploy, gke, configmap]
importance: core
---

# Setup wizard step 2 fails: /manifest/launch returns ENOENT 500

## Symptom

On the deployed demo (portal-demo.shipitops.com), first-run setup step 2
("Connect GitHub sign-in") opens
`/api/connectors/github/manifest/launch`, which returns
`{"error":{"code":"ENOENT","message":"Internal server error"}}`. The
wizard sits on "Waiting for GitHub…" forever.

## Root cause

`GitHubAppManifestService.buildManifest()` reads the manifest template
from disk at request time
(`packages/api-server/src/services/github-app-manifest-service.ts:148`).
The path is wired in `packages/api-server/src/index.ts` (both setup-mode
~L133 and normal-mode ~L212) as
`resolve(configDir, 'config/github-app-manifest.json')`, where
`configDir = dirname(SHIPIT_CONFIG)`.

On-cluster, `SHIPIT_CONFIG=/data/shipit.config.yaml` and `/data` is an
emptyDir seeded by an init container from the `shipit-config` ConfigMap
(infra repo `charts/shipit-ai/templates/_helpers.tpl`). That ConfigMap
ships exactly two keys: `shipit.config.yaml` and `shipit-schema.yaml`
(seeded to `config/shipit-schema.yaml`). **Nothing seeds
`/data/config/github-app-manifest.json`**, and the api-server image
can't supply it either — its Dockerfile only copies `packages/*` and the
runtime stage is `pnpm deploy --prod` output, so the repo-root `config/`
directory never enters the image. `readFileSync` → ENOENT → Fastify 500
with `code: "ENOENT"`.

Works locally because local dev finds `shipit.config.yaml` at the repo
root, where `config/github-app-manifest.json` actually exists.

## Resolution (Option A, implemented 2026-06-11)

User chose Option A: ship the template with the api-server package.

- `config/github-app-manifest.json` → `packages/api-server/config/`
  (git mv; the root `config/` now holds only `shipit-schema.yaml`).
- New `resolveManifestTemplatePath()` in
  `github-app-manifest-service.ts`: returns
  `SHIPIT_GITHUB_APP_MANIFEST_TEMPLATE` (resolved) when set, else the
  packaged file via `import.meta.url` (`../../config/…` works from both
  `src/services/` and `dist/services/`). Both `index.ts` wiring sites
  (setup mode + normal mode) now call it; configDir-relative resolution
  is gone.
- Verified: 246 api-server tests green (2 new TDD tests), typecheck,
  build, prettier, AND `pnpm deploy --legacy --prod` output contains
  `config/github-app-manifest.json` — the exact mechanism the
  Dockerfile's runtime stage uses, so the image now ships the template.
  No infra change needed.

Option B (seed via ConfigMap, D17a pattern) was rejected: the template
is app-owned data (permissions/events the App needs) and should version
with the image.

## Related

- [setup-mode-first-boot](../decisions/setup-mode-first-boot.md)
- [image-build-owned-by-infra-repo](../decisions/image-build-owned-by-infra-repo.md)
- [github-app-manifest-flow](../decisions/github-app-manifest-flow.md)
