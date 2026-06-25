---
type: plan
status: active
created: 2026-06-25
updated: 2026-06-25
author: claude-session-2026-06-25-feedback-widget
tags: [ds, design-system, feedback, fab, toast, ship-it-design]
importance: standard
---

# DS upstream asks for the feedback widget (handoff prompt → ship-it-design)

## Goal

The "Report a problem" widget shipped using only existing `@ship-it-ui/ui` primitives
(`FAB`, `Dialog`, `Field`/`Input`/`Textarea`/`Select`, `Checkbox`, `useToast`, the `z-*`
token scale) — nothing blocked it. These are quality-of-life DS additions so the next
floating widget is cleaner. Consume on the next coordinated `@ship-it-ui/*` bump; until
then the local hand-rolls below stay (drop on bump).

## Approach (paste into the `ship-it-design` repo)

Open a changeset in `~/Repos/Ship-It-Ops/ship-it-design` (CI order: format→lint→typecheck
→test→build; tokens auto-generated from TS source):

1. **`FabDock` / fixed-position floating slot** (patch/minor). Today `FAB` is only the
   round button, so consumers hand-roll `fixed bottom-6 right-6 z-sticky`. Add a wrapper
   that owns `position: fixed`, corner placement (`bottom-right` default), safe-area insets
   (`env(safe-area-inset-*)`), and a z-index token. Keeps launchers consistent.
2. **`--z-fixed` token** (patch) between `--z-sticky` and `--z-overlay` for floating
   launchers — so the FAB layers above page chrome but below modals/toasts predictably.
   Add to `tokens` source + `globals.base.css`; mirror into the consumer's local
   `globals.css` bridge on bump (per the DS theme-bridge re-sync step).
3. **Imperative `toast()` singleton** (minor) — a non-hook `toast.success/error(...)` so
   async handlers outside the React tree can fire toasts. Today only the `useToast()` hook
   exists (fine for this widget, which is in-tree).
4. **(Lower priority)** a generic `Portal` export and a scroll-locked `Dialog` body +
   sticky footer for long forms.

## Local hand-rolls to remove on the next DS bump

- `packages/web-ui/src/components/feedback/feedback-widget.tsx`: the launcher wrapper
  `<div className="z-sticky fixed right-6 bottom-6">` → replace with `FabDock` once it ships.

## Status

Not yet filed upstream. Widget is live on existing primitives; these are non-blocking.

## Related

- [feedback-widget-service-identity](../decisions/feedback-widget-service-identity.md) — the widget this supports
- [ds-upstream-theming-prompt](./ds-upstream-theming-prompt.md) — the handoff-prompt template/workflow
