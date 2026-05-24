---
type: scar
status: active
created: 2026-05-22
updated: 2026-05-22
author: claude-opus-4-7
tags: [bullmq, scheduler, event-bus, silent-failure, connector]
importance: core
incident-date: 2026-05-22
tripwire: 'if a connector card is stuck on `syncing`/`degraded` with `lastRuns: []` even after restart, the SyncScheduler probably failed to attach silently — check api-server stdout for `SyncScheduler init failed`'
---

# BullMQ 5 forbids `:` in queue names and custom job IDs — failures are silent and look like "stuck syncing"

## What Happened

The GitHub connector wizard completed end-to-end (App created, installation linked, connector instance persisted to YAML), but the card stayed perpetually on `syncing` / `degraded` and the drawer's **Runs** tab was empty even after multiple API-server restarts. Manual **Sync now** clicks appeared to fire but never produced a run.

Root cause: **two separate BullMQ 5 colon restrictions**, both surfacing as silent failures:

1. **Queue name** — `sync-scheduler.ts` declared `const DEFAULT_QUEUE = 'shipit:sync:github'`. `new Queue('shipit:sync:github', ...)` throws synchronously in BullMQ 5 with `Queue name cannot contain :`. The `try/catch` around scheduler construction in `packages/api-server/src/index.ts` caught it and logged `SyncScheduler init failed (continuing with no-op runner): ...` as a `console.warn`. The `ConnectorRegistry` kept its default `NoopRunner`, whose `triggerSync` returns `{state: 'idle'}` without enqueuing anything. The web-UI fallback in `connectorInfo()` (`packages/web-ui/src/lib/api.ts`) paints "enabled with no runtime signal and no recorded runs" as `degraded` — visually a `syncing` chip — so the card looked like a sync was perpetually in progress.

2. **Custom job IDs** — Once the queue name was fixed and the scheduler attached, the first real sync failed with `Custom Id cannot contain :`. The event-bus producer (`packages/event-bus/src/bullmq/producer.ts`) built BullMQ `opts.jobId` values as `${connectorId}:${node.id}:${version}`, where `node.id` is a canonical URI like `shipit://LogicalService/github/payments-api`. Every entity-publish failed at `Queue.addBulk`, surfacing on the connector card as the run-level error string.

The reason both were "stuck" rather than visibly broken: the api-server's stdout is verbose and the `console.warn` from the catch block was easy to miss, while the connector card's `degraded`/`syncing` fallback was _designed_ to be reassuring during the first-sync window.

## Tripwire

If a freshly-created GitHub connector shows `syncing` or `degraded` on the card with **no recorded runs** in the drawer's Runs tab and the state survives an API-server restart, the SyncScheduler is almost certainly running as `NoopRunner`. Confirm one of the following:

- `curl http://localhost:3001/api/connectors/<id>/status` returns `{state: 'idle'}` (NoopRunner signature) after a `POST /sync` call — the real scheduler would set `state: 'running'`.
- `docker exec docker-redis-1 redis-cli KEYS "bull:shipit-sync-github:*"` is empty when at least one connector is enabled.
- The api-server console at boot contains `SyncScheduler init failed (continuing with no-op runner): …` (without this scar's fix in place, the message reads `Queue name cannot contain :`).

If you see those, **the runner never attached**. The error is in BullMQ's synchronous validation, not your config.

## Why It Hurt

Burned the full mid-flow wizard verification window. The user thought the scheduler-attach fix from the previous session hadn't taken effect (it had — the eager-attach refactor was correctly loaded), but a separate BullMQ 5 validation error was throwing inside the `try` block at the same point, masking the real failure. The catch swallowed the message into a warn-level log that scrolls past, and the UI's "be optimistic during first sync" fallback hid the symptom for the user. We spent time hypothesizing transpile issues, stale processes, and config substitution before instrumenting the registry directly.

## Don't Do This

- **Don't use `:` in BullMQ queue names.** Hyphenate (`shipit-sync-github`). BullMQ reserves the colon for its internal `bull:<queue>:<key>` keyspace and `new Queue(...)` throws synchronously.
- **Don't use `:` in BullMQ custom job IDs (`opts.jobId`, `opts.repeat.jobId`).** Same restriction, same synchronous throw — but at `addBulk`/`add` time, not construction time. Canonical IDs using the `shipit://...` URI scheme MUST be sanitized (we use a global `:` → `~` substitution in `buildIdempotencyKey`) before being handed to BullMQ.
- **Don't catch-and-warn around scheduler/queue construction without surfacing the error in a way the user can see.** The current shape — `console.warn(...continuing with no-op runner...)` — is sound _if_ a developer remembers to read the boot log. Consider escalating to `console.error` and/or returning a structured boot diagnostic on `GET /api/health` so the web-UI can surface "scheduler failed to attach" instead of silently fronting a NoopRunner.
- **Don't trust the connector card's `syncing`/`degraded` fallback as proof that work is in progress.** It's a UX fallback for the first-sync window; the source of truth for "did any sync run" is `GET /api/connectors/<id>/runs`, which returns `[]` when the runner never moved.

## Related

- [github-connector-architecture-v1](../decisions/github-connector-architecture-v1.md)
- [github-app-manifest-flow](../decisions/github-app-manifest-flow.md)
- [connector-runner-injection](../patterns/connector-runner-injection.md) — Registry ↔ Runner contract; this scar is what happens when the swap silently doesn't take.
- [live-reference-for-hot-reload](../patterns/live-reference-for-hot-reload.md)
