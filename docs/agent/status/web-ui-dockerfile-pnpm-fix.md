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

Second cross-repo brief (2026-06-11): backend images crashed at runtime
(`ERR_MODULE_NOT_FOUND`) — runtime stages of api-server / core-writer /
mcp-server now use `pnpm deploy --legacy --prod` instead of copying the
root `node_modules`. All three verified locally (import probes + boot to
config stage). See
[backend-images-runtime-module-not-found](../investigations/backend-images-runtime-module-not-found.md).

PR #57 (`fix-docker`) carries the work; a Prettier-loop lint fix in the
investigations doc is also pending commit.

Third cross-repo brief (2026-06-11): first-boot SETUP MODE implemented
(api-server boots a wizard-only surface when auth is unconfigured and the
GSM store is fresh; web-ui gained a public /setup wizard page) plus the
core-writer `CMD dist/main.js` fix. See
[setup-mode-first-boot](../decisions/setup-mode-first-boot.md). All
builds/tests/lint green locally; manual forced-setup-mode boot verified.
NOTE: needs infra Terraform for TWO GSM containers before it works
on-cluster: `shipit-auth-admin-emails` and `shipit-setup-completed` (the
latter added for PR #59 review finding SC2 — one-way latch preventing
setup-mode re-entry on previously-secured deployments). If the infra
brief was already sent with only one container, amend it.

First prod page-load (2026-06-11): login showed "401 listing providers"
instead of redirecting to /setup. Root cause: web-ui treats
SHIPIT_API_URL as a base and appends `/api/...`, but infra builds the
image with SHIPIT_API_URL=/api (single-origin Ingress) → every browser
call became `/api/api/...`, which setup-mode 401s. Fixed app-side:
`normalizeApiBaseUrl` in web-ui client-config strips a trailing `/api`
('/api' → '' → same-origin relative calls). Affects ALL web-ui API
calls, not just setup mode. Same-day LB-wide 502s observed during
diagnosis are infra-side NEG churn, separate.

Fourth cross-repo brief (2026-06-11): core-writer ignored
`NEO4J_DATABASE` — `Neo4jClient.getSession` hard-defaulted to db `neo4j`
(absent on instance-ID-named Aura tiers) AND `main.ts` never passed the
configured database into `connect()` (the brief missed that second leg —
shared config has no database field; it rides in via core-writer's
`DEFAULT_CONFIG`). Fixed both; verified locally in both directions
(sentinel db name reaches the driver; default boots through migration +
event-bus subscribe).

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
