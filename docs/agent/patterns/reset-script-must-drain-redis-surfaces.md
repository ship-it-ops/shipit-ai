---
type: pattern
status: active
created: 2026-05-31
updated: 2026-05-31
author: claude-opus-4-7
tags: [reset, redis, neo4j, bullmq, dev-workflow, connector]
importance: core
---

# `pnpm seed:reset` must drain every Redis surface, not just Neo4j

## When to Use

Whenever a new persistent surface for connector or graph state is introduced — a new Redis key prefix, a new BullMQ queue, a new on-disk store — the reset script needs a matching wipe step. The default assumption "I cleared Neo4j so the graph is empty" is wrong: pending BullMQ jobs replay on the next worker boot and silently rebuild the graph, and stale connector run history confuses the UI's "last sync" badges.

The script intentionally does **not** touch `shipit.config.local.yaml` connector instances or `schema-history/` — those are configuration / audit, not connector-derived data. A clean reset that preserves those means the next connector tick repopulates the graph from the same source of truth instead of forcing a manual GitHub App re-onboard.

## Implementation

`scripts/seed-reset.ts` wipes, in order:

1. **Neo4j** — `MATCH (n) DETACH DELETE n` against the dev database. Covers domain nodes, edges, `_LinkingKey`, and `_IdempotencyLog`.
2. **Connector run history** — `SCAN + UNLINK` against the pattern `shipit:connector-runs:*`. Source of truth: `packages/api-server/src/services/connector-run-store.ts` (`KEY_PREFIX`).
3. **BullMQ queues** — `SCAN + UNLINK` against `bull:<queue>:*` for each queue in the script's `BULL_QUEUES` constant:
   - `shipit-events` — event-bus (`packages/event-bus/src/config.ts:21`, `DEFAULT_CONFIG.queueName`).
   - `shipit-sync-github` — sync-scheduler (`packages/api-server/src/services/sync-scheduler.ts`, `DEFAULT_QUEUE`).

The script refuses when `NODE_ENV=production` without an explicit `--force-production` flag, and prompts for `"wipe"` confirmation unless `--yes` is passed. `assertNotProduction` is exported and unit-tested in `scripts/seed-reset.test.ts`.

## Examples

Drop-in extension pattern when a new queue lands — say a future `shipit-reconciliation` queue:

```ts
// scripts/seed-reset.ts
const BULL_QUEUES = [
  'shipit-events',
  'shipit-sync-github',
  'shipit-reconciliation', // ← add here
] as const;
```

Same pattern for any new Redis key family. If the prefix ever ships with a colon embedded inside the queue name itself (don't — see [bullmq-5-forbids-colons-in-queue-names-and-job-ids](../scars/bullmq-5-forbids-colons-in-queue-names-and-job-ids.md)), the SCAN match must be updated.

## Gotchas

- **Replay is silent.** Skipping the BullMQ drain looks identical to "reset worked" — Neo4j shows empty in the UI, then 30 seconds after the next API server boot the pending events replay through `core-writer` and the graph fills back in with nodes that weren't in the seed file. The user will swear the reset script is broken when it's actually doing exactly what it says it does.
- **Don't use `KEYS` on a live Redis.** It's O(N) on a single thread and blocks every other client. The script uses `SCAN` with `COUNT 500` cursors and `UNLINK` (async delete) for the same reason BullMQ does.
- **Connector config is preserved on purpose.** Wiping `shipit.config.local.yaml` means re-running the GitHub App manifest dance, which involves browser-side GitHub OAuth. Preserve it; the connector poll will repopulate Neo4j on its own schedule. If a user explicitly wants a fresh-install state, they can `git clean -fX` the YAML themselves — the script should not make that decision for them.
- **The two queue names are duplicated.** The script hardcodes `shipit-events` and `shipit-sync-github` rather than importing them from `@shipit-ai/event-bus` / api-server. Importing creates a build-order dependency (the script becomes unrunnable until `pnpm build` succeeds), which is hostile in exactly the "things are broken, let me reset" scenario the script exists for. Manual sync is the lesser evil. Document it in this note rather than abstracting it.
- **Run history is per-connector-id, not per-org.** Even after this drain, if a user deletes a connector instance via the API, the registry calls `runStore.clear(id)` so the next instance with the same id starts fresh. The reset script catches this for free since it wipes the whole prefix.

## Related

- [connector-run-storage-redis-not-yaml](../decisions/connector-run-storage-redis-not-yaml.md) — the decision that created the `shipit:connector-runs:*` surface this script drains.
- [bullmq-5-forbids-colons-in-queue-names-and-job-ids](../scars/bullmq-5-forbids-colons-in-queue-names-and-job-ids.md) — sibling guidance on BullMQ queue naming. If a new queue is added, its name must satisfy both that scar's rules and this pattern's drain step.
- [internal-node-label-underscore-prefix](./internal-node-label-underscore-prefix.md) — explains why `DETACH DELETE` on `MATCH (n)` is correct (it catches the `_`-prefixed bookkeeping nodes too).
