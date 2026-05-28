---
type: status
status: active
created: 2026-06-23
updated: 2026-06-23
author: claude-session-2026-06-23-catalog-rebase
branch: catalog-enhancements
agent: claude-session-2026-06-23-catalog-rebase
tags: [catalog, web-ui, graph, connector-identity, rebase, source-connector]
---

# Rebase `catalog-enhancements` onto current main

Reviving the per-node source-connector identity feature (commit 54fb7a2,
"Improvments to catalog", May 28). Confirmed NOT in main; branch was 28 commits
behind / 1 ahead, merge-tree flagged ~34 conflict markers.

## Scope (the single commit adds)

- web-ui: `connector-identity.ts`, `connector-pill.tsx`, catalog page + detail,
  graph filter-panel/canvas, entity-search, graph-store, api.ts, use-graph-data,
  use-search.
- api-server: `routes/graph.ts`, `services/neo4j-service.ts` (+ graph.test).
- core-writer: `writer.ts`, `neo4j/queries.ts` (+ writer.test).
- shared: `types/canonical.ts`.
- decision: `per-node-source-connector-id.md`.

## Conflict risk

Lands on the most-churned files since May 26: Cut B freshness rewrote
`core-writer/queries.ts` + `writer.ts` + `canonical.ts`; per-field confidence
touched the graph routes. Conflicts expected there.

## Conflict resolutions (13 files)

- **core-writer/queries.ts** — kept Cut B's atomic in-Cypher CAS freshness
  guard; injected `_source_connector_id = $sourceConnectorId` inside the
  `FOREACH` SET + added the param. The two features compose: connector-id is
  stamped only on an accepted (non-rejected) write.
- **core-writer/writer.ts** — kept Cut B's `{ written }` return + freshness-skip
  counting; kept the `_source_connector_id: event.connector_id` stamp; merged comments.
- **api-server/neo4j-service.ts** — merged signatures: `getOverview(_ctx,
limitOrOpts)` (main's RequestContext + catalog's source-filter opts).
  `getSources()` landed clean.
- **api-server/routes/graph.ts** — `getOverview(request.ctx, {limit, source…})`
  - kept the new `/sources` route.
- **graph.test.ts** — single mock record serves both: `get('labels')` returns
  `['LogicalService']`, name stays `graph-api` (main) AND carries source
  provenance (catalog). Fixed catalog's `toHaveBeenLastCalledWith` to expect
  `ctx` as the first arg on searchEntities/getOverview.
- **writer.test.ts** — kept the full Cut B freshness-guard `describe` AND the new
  connector-id stamp `it`.
- **web-ui filter-panel.tsx** — dropped the obsolete `staticFacets` (main now
  derives facets from `data`); kept the dynamic Source facet, appended to derived.
- **filter-panel.test.tsx** — every render wraps in `withQueryClient` (FilterPanel
  now uses React Query hooks) AND passes `data` (facets are data-derived).
- **graph-canvas.tsx** — kept main's `ownershipIndex` owner filter + added
  catalog's source filter as a separate block.
- **use-graph-data.ts**, **catalog/[id]/page.tsx** — union-merged imports/hooks
  (claims + connector-identity both kept).
- **node-detail-panel.tsx** — took main's restyled Badge (catalog's `ml-auto`
  tweak was superseded).
- **MANIFEST.md** — took main's; re-added the `per-node-source-connector-id` entry.

## Status — COMPLETE (local only)

Rebased onto current main (was 28 behind / 1 ahead). Single commit `8e6ba26`
"Improvments to catalog" now sits on top of `bb83e9e`.

Verified: `pnpm -r typecheck` clean (needed a `@shipit-ai/shared` rebuild so
core-writer picks up the new `_source_connector_id` type from dist); tests green
— core-writer 84, api-server 401, web-ui 118; web-ui lint 0 errors (18
pre-existing warnings, none in touched files); prettier applied.

NOT pushed (standing rule: explicit approval per push). Awaiting user decision:
push `catalog-enhancements` + open PR, or hold.
