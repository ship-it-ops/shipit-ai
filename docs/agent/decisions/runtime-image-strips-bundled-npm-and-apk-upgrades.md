---
type: decision
status: active
created: 2026-09-15
updated: 2026-09-15
author: claude-fable-5-1-session-01Au4gDpcAj93LDvrEzXqLsE
tags: [docker, security, trivy, base-image, npm, alpine, deploy]
importance: core
---

# Runtime image stages strip the base image's bundled npm CLI and `apk upgrade`

## Context

Images are built and gated in the sibling `shipit-ai-infra` repo (`build-images.yml`):
after `docker build`, Trivy scans the image with `--severity HIGH,CRITICAL --ignore-unfixed
--exit-code 1`, and only a clean image is pushed to Artifact Registry. On 2026-09-15 the
build of main `425f472` failed the gate on **all four images** with findings that were
entirely in the `node:22-alpine` base image, not in app code:

- OS: `libcrypto3 3.5.7-r0` → fix `3.5.8-r0` (CVE-2026-14456, HIGH).
- The **npm CLI vendored in the base image** (`/usr/local/lib/node_modules/npm/...`):
  `tar` (CVE-2026-59873 CRITICAL + 2 HIGH), `brace-expansion` ×3, `ip-address`, `pacote`,
  `sigstore`, `@npmcli/metavuln-calculator` — 10 findings, none reachable at runtime.

The infra repo had already accepted one such finding (picomatch, CVE-2026-33671) with a
**path-scoped, expiring** `.trivyignore.yaml` entry (infra decision D27, expiry
2026-09-30) and named the durable fix as "strip/upgrade the base-image npm in the app-repo
Dockerfiles — not yet in place". This is that fix.

## Decision

In the **runtime stage only** of every service Dockerfile (`packages/{api-server,
core-writer,mcp-server,web-ui}/Dockerfile`), immediately after the stage's `FROM`:

```dockerfile
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
```

Safe because every runtime `CMD` is plain `node …` against a pnpm-deployed (or Next
standalone) tree; nothing invokes npm/npx at runtime. `corepack enable pnpm` runs in
builder stages (web-ui's shared `base` stage), and corepack is a separate package under
`/usr/local/lib/node_modules/corepack` — untouched. In web-ui the `RUN` sits before
`USER nextjs` because it needs root.

## Alternatives Considered

- **Bump the base tag / wait for a rebuilt `node:22-alpine`**: rejected — npm's vendored
  deps lag upstream fixes for months; the gate would keep re-blocking on the next CVE.
- **More path-scoped `.trivyignore.yaml` entries in infra**: rejected as the primary fix —
  it's the documented stopgap, and the openssl finding is an OS package with a fix
  available (suppressing it would be wrong).
- **Switch to a distroless / `node:22-slim` runtime**: a bigger change (no `apk`, different
  shell/debug ergonomics); tracked in infra's `v2-container-hardening` open question.

## Consequences

- The infra `.trivyignore.yaml` picomatch entry (and its VEX record) can be **removed** once
  an image built from this change passes the gate without it — infra D27's revisit trigger.
- `apk upgrade` makes the runtime layer track Alpine's security repo at build time; the
  image is still pinned to one immutable `sha-<short>` tag per build, so reproducibility
  is per-tag, not per-Dockerfile.
- Verification surface: the app repo's CI `Docker Build (*)` jobs build api-server,
  core-writer and mcp-server (`push: false`) — they prove the `RUN` succeeds. **web-ui is
  built only by the infra workflow**, so its runtime change is first exercised there.

## Revisit Triggers

- The image gate flags something under `/usr/local/lib/node_modules/corepack` — decide
  whether to strip corepack from runtime stages too (only builders need it).
- Moving to a slim/distroless runtime base (drop the `apk` line then).

## Related

- [image-build-owned-by-infra-repo](image-build-owned-by-infra-repo.md) — why the gate lives in the other repo
- [docker-copy-of-host-artifacts-poisons-image-builds](../scars/docker-copy-of-host-artifacts-poisons-image-builds.md)
- [dependabot-resolution-strategy](dependabot-resolution-strategy.md) — the app-dependency side of the same audit posture
