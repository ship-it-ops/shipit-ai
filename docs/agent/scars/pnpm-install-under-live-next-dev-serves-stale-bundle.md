---
type: scar
status: active
created: 2026-06-19
updated: 2026-06-19
incident-date: 2026-06-19
author: claude-session-2026-06-18-ds-upgrade
tripwire: "local web-ui suddenly empty/blank/broken right after a dep change (pnpm install / DS bump) → it's the still-running `next dev` serving a stale bundle against swapped node_modules; restart it BEFORE suspecting data loss"
tags: [web-ui, dev-server, next, turbopack, pnpm, operations]
---

# `pnpm install` under a live `next dev` serves a broken/stale bundle (looks like data loss)

## What Happened

During the `@ship-it-ui/*` DS upgrades, `pnpm install` swapped `node_modules`
while the user's `next dev` web-ui (`:3000`) was still running — it had been
started BEFORE the upgrade. A live Next/turbopack dev server keeps the old modules
in memory and serves a half-stale bundle against the new `node_modules`: pages
render empty or wrong. First it showed a blank "white box" (stale CSS chunk); later
the connectors page showed NO connectors — which read as data loss.

It was NOT data loss. The connector definitions were intact in
`shipit.config.local.yaml` (both `github-*` connectors), Redis still had each
connector's run history (20 runs each), and `docker-redis-1`/`docker-neo4j-1` had
been up 8 days untouched. Restarting the web-ui dev server made the connectors
reappear.

## Tripwire

Local web-ui goes empty/blank/broken right after a dependency change (`pnpm install`,
a DS/version bump, branch switch). Before suspecting data loss: it's the stale
`next dev` (started before the install) serving against swapped `node_modules`.

## Why It Hurt

Looks identical to data loss — the natural panic is "where did my data go?". Real
state lives in config (`shipit.config.local.yaml`), Redis, and Neo4j, none of which
a frontend `pnpm install` touches. Chasing it as data loss wastes time and risks a
destructive "recovery."

## Don't Do This

- Don't run `pnpm install` / a dep upgrade and keep using the already-running
  `next dev` — restart the web-ui (and confirm api-server is up) so it loads fresh
  `node_modules`. Kill the stale `:3000` server first so it isn't holding the port.
- Don't conclude data loss from an empty local UI. Check the stores first:
  `grep connectors shipit.config.local.yaml`, `redis-cli --scan 'shipit:*'`,
  `docker ps` (are redis/neo4j up?). Same "empty UI + healthy stores" pattern as
  the Redis-OOM scar.

## Related

- [redis-memory-limit-below-dataset-oomkills](./redis-memory-limit-below-dataset-oomkills.md) — sibling "empty UI ≠ data loss" pattern
- [tailwind-spacing-screen-key-shadows-h-screen](./tailwind-spacing-screen-key-shadows-h-screen.md) — the white-box variant of the same stale-bundle session
- [ds-upgrade-to-latest](../status/ds-upgrade-to-latest.md)
