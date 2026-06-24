---
type: open-question
status: active
opened: 2026-06-23
answer-source: maintainer
tags: [neo4j, performance, indexes, scale, core-writer]
importance: standard
---

# Should we add Neo4j indexes (none exist today) before the graph grows?

## Context

Surfaced by the PR #87 review (finding IN7/DA4). The repo declares **no Neo4j
indexes or constraints anywhere** — verified by grep (`CREATE INDEX|CONSTRAINT`
returns nothing in source). Every graph query is a full scan:

- `getSources()` (`api-server/services/neo4j-service.ts`) — unlabeled
  `MATCH (n)` grouping on `_source_system` / `_source_connector_id`.
- `getOverview()` source filter predicates on the same properties.
- Likely others (`_last_synced`, label scans, `id` lookups in core-writer).

Fine at current scale (~55 nodes in the demo) and the source facet is
React-Query cached, so IN7 was deferred from #87 as advisory — not a one-query
fix but a project-wide decision.

## Tried

Nothing yet — consciously deferred to avoid landing index infra (and a
migration/bootstrap mechanism, which also doesn't exist) inside an unrelated
feature PR.

## Status — parked as future backlog (decided 2026-06-23)

Maintainer decision: **not ready to start defining indexes yet.** Keep this as a
future todo. Revisit when the graph grows beyond demo scale (the Revisit Trigger
below) or when we build the missing migration/bootstrap mechanism for any other
reason. Do not land index infra until then.

## Who Can Answer

Maintainer / whoever owns the Neo4j schema lifecycle. Decision needed: (a) when
does graph size justify indexes, (b) where do index/constraint declarations
live (core-writer bootstrap? a migration step?), (c) which properties to cover
first — `id` (lookup), `_source_system`/`_source_connector_id` (facets),
`_last_synced` (freshness/sort).

## Related

- [catalog-exclude-hide-types](../status/catalog-exclude-hide-types.md)
- [per-node-source-connector-id](../decisions/per-node-source-connector-id.md)
