---
type: decision
status: active
created: 2026-06-07
updated: 2026-06-07
author: claude-session-2026-06-07
tags: [ci, images, artifact-registry, security, public-repo, cross-repo, deployment]
importance: core
---

# Image build + publish is owned by the infra repo, not this public app repo

## Context

Infra repo (`Ship-It-Ops/shipit-ai-infra`) brief D10 originally asked **this**
repo's CI to build all 4 images and push them to GCP Artifact Registry (AR) via
Workload Identity Federation (WIF), gated to `main`. That path was briefly
implemented in `.github/workflows/ci.yml`, then reversed.

**`Ship-It-Ops/ShipIt-AI` is a public repo.** Granting its CI an
identity that can write to AR (even short-lived WIF, even gated to `main`)
puts GCP-write reach behind a large, public attack surface — fork PRs,
workflow edits, and the general exposure of a public Actions environment. The
operator chose to keep **all GCP-write credentials on the private side**.

## Decision

**The infra repo owns image build + publish.** It checks out / clones a pinned
ref of `Ship-It-Ops/ShipIt-AI`, builds the 4 images on its own (private) CI,
and pushes them to AR with its own WIF identity. This public app repo:

- **Does not push images** and holds **no GCP/AR/WIF credentials**.
- Keeps its `docker` CI job as **build-only validation** (`push: false`) — same
  as before this episode: `api-server`, `core-writer`, `mcp-server`. (Reverted
  the temporary 4-image + WIF-push change; `ci.yml` is back to its prior shape.)
- Exposes nothing new cross-repo: no `repository_dispatch`, no PAT, no App token.

### Build details the infra repo needs (the real contract now)

- Dockerfiles: `packages/<service>/Dockerfile` for `api-server`, `core-writer`,
  `mcp-server`, `web-ui`. Build context = repo root.
- **web-ui must be built with `--build-arg SHIPIT_API_URL=/api`** (relative) —
  it bakes the API base into the JS bundle, and behind the single-origin Ingress
  the browser calls `/api` on its own origin (`packages/web-ui/Dockerfile:18`).
  The other three Dockerfiles take no build-args.
- Image path / tags are entirely the infra repo's choice (e.g.
  `us-central1-docker.pkg.dev/<project>/shipit/<service>:<ref>`); the app repo
  has no opinion since it doesn't publish.

## Alternatives Considered

- **App-repo CI pushes to AR via WIF** (the original brief, briefly built).
  Rejected — public repo + GCP-write identity is the wrong trust boundary.
- **App-repo CI pushes to GHCR.** Rejected for the same trust reason (plus the
  pull-secret / public-image tradeoffs weighed earlier the same day).
- **Drop the `docker` CI job entirely.** Rejected — build-only validation still
  catches Dockerfile breakage in PRs before infra tries to build the same files.

## Consequences

- Zero deploy/registry credentials live in the public repo.
- The infra repo's deploy pipeline gains a build step (clone → build → push)
  before its existing `helm upgrade`. Deploy is still operator-triggered
  (manual `workflow_dispatch`); no automated app→infra signal exists.
- If web-ui Dockerfile breakage slips through (it's currently **not** in the
  app-repo build-only matrix), the infra build catches it later. Consider adding
  `web-ui` as a 4th build-only matrix entry here to shift that left — deferred,
  operator's call.

## Revisit Triggers

- App repo goes private → app-repo-side publish via WIF becomes reasonable again.
- Wanting to shift web-ui Dockerfile validation left → add it to the build-only
  matrix.

## Related

- [k8s-deployment-architecture](../plans/k8s-deployment-architecture.md) — the GKE deployment these images feed
- [api-server-config-persistence-strategy](api-server-config-persistence-strategy.md) — sibling cross-repo brief resolved the same day (their D13)
- [hosting-gke-distributed-not-vercel](hosting-gke-distributed-not-vercel.md) — why GKE, the target these images deploy to
