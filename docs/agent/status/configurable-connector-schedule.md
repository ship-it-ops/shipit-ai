---
type: status
status: active
created: 2026-06-19
updated: 2026-06-19
author: claude-opus-4-8
branch: next-release
agent: claude-session-2026-06-19-schedule
tags: [connectors, scheduling, web-ui, cron]
importance: standard
---

# Make connector sync schedule user-configurable (setup + edit), 30-min default, too-frequent warning

## Scope

- `packages/shared/src/config/schema.ts` — schedule default `*/15`→`*/30`, add cron-shape `.refine()`.
- `packages/api-server/src/services/connector-registry.ts` — fallback default `*/15`→`*/30`.
- `packages/api-server/src/__tests__/routes/connectors.test.ts` — expected default.
- `packages/web-ui/src/lib/schedule.ts` (+ test) — presets + cron↔minutes + isTooFrequent helper.
- `packages/web-ui/src/components/connectors/schedule-field.tsx` (new) — Select + custom cron + warn Banner.
- `connector-detail-drawer.tsx` SettingsTab + `add-github-connector-wizard.tsx` (+ test) — use ScheduleField; wizard now collects/submits schedule.

## Why

User request: cron schedule configurable during connector setup and afterward;
default 30 min; concise warning (not a block) when interval is very frequent
(e.g. 5–10 min) because it's heavy on the system. Backend `schedule` was already
plumbed end-to-end (BullMQ repeatable jobs) and editable post-setup via a raw
cron input; this adds the wizard field, the 30-min default, the friendly picker,
and the warning. Plan: `~/.claude/plans/for-the-github-and-wondrous-ullman.md`.

## Notes

- Shared surfaces (connector schema + registry) also touched by Portal Settings /
  webhook receiver work — coordinate before large schema edits.
