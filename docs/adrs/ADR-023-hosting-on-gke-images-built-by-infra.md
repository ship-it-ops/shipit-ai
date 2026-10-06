# ADR-023: Host the Distributed Stack on GKE; the Infrastructure Repository Builds and Publishes Images

## Status

Accepted

## Date

2026-06-04 (image ownership: 2026-06-07)

## Context

ShipIt-AI is persistent and stateful: an always-on api-server with an embedded poller, a non-HTTP queue worker, Redis for the queue, sessions and run history, and Neo4j. Connector syncs run for minutes. The first hosting idea was Vercel, where the team already had an account; a design exploration showed what that would cost: multi-minute syncs exceed function limits, and connector configuration, schema, run history and the GitHub App key would all have to leave the filesystem and Redis.

This repository is public. Giving its CI an identity that can write to a container registry puts cloud-write reach behind a large public attack surface.

## Decision

- Deploy the **existing distributed stack unchanged on managed Kubernetes (GKE)**, with a single-origin ingress (`/` to the web UI, `/api` to the api-server) that keeps the Redis session store and avoids cross-domain cookies. Neo4j is managed (Aura) for the demo tier; Redis and Postgres run in the cluster.
- **The private infrastructure repository (`shipit-ai-infra`) owns image build and publish.** It clones a pinned ref of this repository, builds the images (`packages/<service>/Dockerfile`, build context at the repository root; the web UI with `--build-arg SHIPIT_API_URL=/api`), scans them, and pushes them with its own identity. This repository's `docker` CI job builds for validation only and holds no cloud credentials. Deploys are operator-triggered.

## Consequences

### Positive

- No application code changed to be hosted; a deployment is an infrastructure project.
- Zero registry or cloud credentials in the public repository.
- Kubernetes experience transfers; the control plane is free on the chosen tier.

### Negative

- Two repositories to coordinate; each new worker process needs a brief for the infrastructure side (`docs/agent/briefs/`).
- A Dockerfile that is not in this repository's build matrix breaks first in the infrastructure build.

### Neutral

- Production hardening (HA Neo4j, autoscaling, node pools) is deferred to a commercial tier.

## Alternatives Considered

### All on Vercel (serverless)

- **Cons:** Function duration caps, no persistent filesystem or Redis, a large re-architecture to fit the platform.

### Cloud Run or Fargate

- **Cons:** Fights the always-on non-HTTP worker; the team wanted Kubernetes specifically.

### This repository's CI publishes images through workload identity

- **Cons:** Public repository plus cloud-write identity is the wrong trust boundary.

## References

- `docs/agent/decisions/hosting-gke-distributed-not-vercel.md`, `image-build-owned-by-infra-repo.md`
- `docs/deployment.md`
