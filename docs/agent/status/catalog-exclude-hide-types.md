---
type: status
status: active
created: 2026-06-23
updated: 2026-06-23
author: claude-session-2026-06-23-catalog-rebase
branch: catalog-enhancements
agent: claude-session-2026-06-23-catalog-rebase
tags: [catalog, web-ui, filtering, exclude, pipelines, ux, tri-state]
---

# Catalog tri-state Type filter — Pipelines hidden by default

Follow-on to the catalog-enhancements rebase (same branch). User ask: an
**exclude** option in catalog filtering, and **Pipelines excluded by default**
(they add noise) with an easy opt-in to show them.

## Design (brainstormed + approved + visually verified)

Initial build was a separate "Hide types" exclude facet; the user then asked for
a **tri-state Type facet** instead: one click **include**, second **exclude/hide**,
third **neutral**. The exclude state must NOT look like a checkmark (avoids
"included vs excluded" confusion).

- **Tri-state Type control** replaces both the include Type facet and the
  separate Hide-types facet. Per type, click cycles **neutral → include →
  exclude → neutral**.
- Indicators: neutral = empty bordered box; include = accent box + `✓`;
  exclude = **err (red) box + `−` (negate)** with the label **struck-through +
  dimmed**.
- **Pipeline excluded by default**; **stateless** (re-applies on every load and
  on Reset; no localStorage).
- Hint by the entity count: `Pipeline hidden · N` (entities hidden _purely_ by
  the exclude state — disappears once an include filter is active, by design).

## Data model (unchanged filtering logic)

The tri-state is a pure projection over two arrays already in the filter:
`types` (include) and `excludeTypes` (exclude). Exclude wins. A type lives in
exactly one array or neither.

## Scope (catalog page only)

The graph explorer's separate filter is untouched. Files:

- **NEW** `app/(app)/catalog/catalog-filter.ts` — pure logic extracted from
  page.tsx: `CatalogRow`, `matches()`/`matchesIncludes()`, `isExcludedByType()`,
  `countHiddenByExclude()`, `DEFAULT_EXCLUDED_TYPES=['Pipeline']`,
  `makeDefaultFilter()`, and the tri-state helpers `TypeState`,
  `getTypeState()`, `cycleTypeState()`.
- **NEW** `app/(app)/catalog/type-filter.tsx` — the custom tri-state control
  (the DS `FilterPanel` only does binary checkbox facets, so Type had to be
  custom; Environment/Tier/Owner/Source stay in the DS panel).
- `app/(app)/catalog/page.tsx` — renders `<TypeFilter>` above the DS panel;
  removed the `types`/`excludeTypes` DS facets; initial+reset state =
  `makeDefaultFilter()`; the hint line.
- **NEW** `catalog-filter.test.ts` (11) + `page.test.tsx` (4, incl. a
  click-to-cycle interaction).

## Impl notes / gotchas

- `IconGlyph` static union does NOT include `minus` (only `check`, `x`). Used
  text marks `✓` / `−` in the indicator instead of icons — robust, no union risk.
- Tokens: include `border-accent bg-accent text-on-accent`; exclude
  `border-err bg-err text-err-fg`; neutral `border-border-strong`; hover
  `hover:bg-panel-2`.
- DS `FilterPanel` reset fires `onValueChange({})` then `onReset()`, so
  `onReset={() => setFilter(makeDefaultFilter())}` wins → Pipeline-hidden default.

## Verified

web-ui typecheck clean; **133 tests pass** (+6 tri-state); lint 0 errors (18
pre-existing warnings, none in touched files); prettier applied. **Visually
verified in the live app** (localhost:3000/catalog, 41/55 entities are Pipelines):
default shows `14 of 55 · Pipeline hidden · 41`; the three states render
distinctly; clicking Repository→include filtered to 11 repos.

## Status

Committing + pushing to `catalog-enhancements` and opening a PR (user approved
2026-06-23).

## Related

- [catalog-enhancements-rebase](./catalog-enhancements-rebase.md)
- [per-node-source-connector-id](../decisions/per-node-source-connector-id.md)
