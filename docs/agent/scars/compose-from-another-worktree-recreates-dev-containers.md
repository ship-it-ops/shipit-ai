---
type: scar
status: active
created: 2026-10-04
updated: 2026-10-04
author: claude-session-2026-10-02 (agents workstream)
tags: [docker, compose, worktree, local-dev, postgres, neo4j]
importance: core
incident-date: 2026-10-04
tripwire: 'if `docker compose up` prints `Container docker-postgres-1 Recreate` when you only wanted to start services, you are running the compose file from a different checkout than the one that created the containers'
---

# Running the compose file from another worktree recreates the dev Postgres and Neo4j containers

## What Happened

To check the agents UI in a browser, `pnpm start:all` was run inside a scratch git worktree.
`scripts/infra.sh` there ran `docker compose -f <that worktree>/docker/docker-compose.yml up -d
neo4j redis postgres`. The compose project name comes from the directory (`docker`), so Compose
treated the owner's running containers as its own, saw that their configuration differed, and
printed `Container docker-postgres-1 Recreate` and `Container docker-neo4j-1 Recreate`.

What differed: the compose file's **relative bind mounts** (`./postgres-init`, the config file
mounts) resolve against the compose file's directory, so they pointed into the scratch worktree.

No data was lost: both databases keep their data in named volumes, and the counts were checked
afterwards (graph nodes, agents, runs, schema version). The containers were then recreated from
the main checkout so their mounts point back at it. Had the scratch worktree been deleted first,
the containers would have held mounts to a directory that no longer exists.

## Tripwire

`Recreate` in `docker compose up` output for a service you did not change. Also: after such a
run, `docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' docker-postgres-1` shows a path
outside the main checkout.

## What To Do Instead

- Start infra only from the main checkout: `pnpm start:infra` there.
- In another worktree, start only the Node processes and skip the infra script:
  `pnpm exec turbo dev` (or `pnpm --filter <package> dev`), with `shipit.config.local.yaml`
  copied in. They connect to the already running containers on localhost.
- If it already happened: from the main checkout run
  `docker compose -f docker/docker-compose.yml up -d neo4j redis postgres`, then check the data.

## Related

- [pnpm-install-under-live-next-dev-serves-stale-bundle](pnpm-install-under-live-next-dev-serves-stale-bundle.md) — another "looks like data loss, is not" local-dev trap.
- [ai-agents-platform-handoff](../status/ai-agents-platform-handoff.md) — where it happened.
