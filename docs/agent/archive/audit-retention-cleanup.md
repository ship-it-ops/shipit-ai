---
type: status
status: completed
created: 2026-06-24
updated: 2026-06-24
author: claude-session-2026-06-24-audit-retention
branch: release-next
agent: claude-session-2026-06-24-audit-retention
tags: [audit, retention, graph-edit-event, neo4j, scheduler, cleanup]
---

# Implementing GraphEditEvent audit retention/cleanup

## Scope

- `packages/shared/src/config/schema.ts` — add `accessControl.manualWrite.auditRetentionDays`.
- `packages/api-server/src/services/audit-retention-service.ts` (new) — batched DETACH DELETE cleanup of old GraphEditEvent nodes.
- `packages/api-server/src/services/audit-retention-scheduler.ts` (new) — daily BullMQ repeatable job wrapping the service.
- Wire into `sync-runtime.ts` / `index.ts` startup; skip when retention disabled.
- Unit + (env-gated) integration tests.

## Why

S6 deferred follow-up from `docs/agent/plans/manual-edit-write-path.md` — GraphEditEvent
growth is unbounded (same incident class as the Redis-stream OOM). Ties into
`docs/agent/open-questions/neo4j-no-indexes-declared.md` (label scan is cheap at
current scale; index on `:GraphEditEvent(ts)` is the eventual optimization).
