---
type: pattern
status: active
created: 2026-05-22
updated: 2026-05-22
author: claude-opus-4-7
tags: [neo4j, schema, graph, convention]
importance: core
---

# Internal node labels use a leading underscore and must be excluded from user-facing graph queries

## When to Use

Whenever you write a Neo4j query that returns nodes to a user-facing surface (graph explorer, dashboard counts, command palette, search), filter out labels that begin with `_`. Whenever you _add_ a new bookkeeping node type that lives in the same graph as user entities, prefix its label with `_` so existing exclusion filters pick it up automatically.

## Implementation

Two kinds of nodes coexist in Neo4j:

1. **Domain entities** — `Repository`, `Team`, `Person`, `Pipeline`, `Service`, etc. They have a canonical `id` property (e.g. `shipit://repository/default/foo`), a `name`, and are surfaced to users.
2. **Writer bookkeeping** — `_LinkingKey`, `_IdempotencyLog`. They live in the same database (so the writer can include them in the same managed transaction as the domain writes), but they have _no_ canonical `id` and no `name` — properties relevant to them are `linking_key` / `canonical_id` / `key` / `expires_at`. They exist to power the reconciler and the idempotency check inside `core-writer`.

The convention: **internal labels begin with `_`**. The api-server's `Neo4jService` defines a single constant and applies it in every user-facing query:

```ts
// packages/api-server/src/services/neo4j-service.ts
const EXCLUDE_INTERNAL_LABELS = "NONE(l IN labels(n) WHERE l STARTS WITH '_')";
```

Currently applied in:

- `getGraphStats` — `db.labels() WHERE NOT label STARTS WITH '_'`
- `getOverview` — `MATCH (n) WHERE ${EXCLUDE_INTERNAL_LABELS}`
- `searchEntities` — added to the `whereClause` array

`getNeighborhood` and `getBlastRadius` start from a known canonical ID (`MATCH (start {id: $nodeId})`) and traverse only via real relationship types (`DEPENDS_ON`, `CALLS`, `MONITORS`, etc.), so they never encounter an `_LinkingKey` or `_IdempotencyLog` in practice — those are point-to nodes referenced by linking keys, not by graph edges. They still inherit the convention if APOC paths are ever broadened.

## Examples

Right (overview):

```cypher
MATCH (n) WHERE NONE(l IN labels(n) WHERE l STARTS WITH '_')
RETURN n, labels(n) AS labels LIMIT $limit
```

Right (search):

```cypher
MATCH (n)
WHERE coalesce(n._deleted, false) = false
  AND NONE(l IN labels(n) WHERE l STARTS WITH '_')
RETURN n, labels(n) AS labels ORDER BY n.name LIMIT $limit
```

Right (stats by label):

```cypher
CALL db.labels() YIELD label
WHERE NOT label STARTS WITH '_'
RETURN label, COUNT { MATCH (n) WHERE label IN labels(n) } AS count
```

## Gotchas

- **Forgetting the filter** is silent until it isn't. The graph explorer surfaced the omission loudly (Cytoscape throws `Can not create element with invalid string ID ''` because `_LinkingKey` nodes lack a canonical `id`), but the stats endpoint and the command palette silently inflate counts and pollute search before anyone notices. New routes should add the filter by default.
- **Properties** also use a `_`-prefix for "internal/system" semantics (`_event_version`, `_claims`, `_last_synced`, `_source_id`, `_deleted`). The label convention is independent — properties get filtered by `sanitizeProperties` in `core-writer/src/neo4j/queries.ts`, labels get filtered at the read site.
- **The Cypher cap on label names** is per-token, not per-character. `_LinkingKey` is one label; you can't `MATCH (:_LinkingKey)` and `MATCH (:LinkingKey)` and expect the same node. Don't strip the underscore at write time as a "shortcut".
- **APOC subgraph traversals** (`apoc.path.subgraphAll`) will happily walk into an `_LinkingKey` if a relationship points at it. Today none do, but if you add one (e.g. a forensic `RECONCILED_VIA` edge), set the `labelFilter` parameter to exclude internal labels at the path layer.

## Related

- [core-writer-runs-as-its-own-process](../decisions/core-writer-runs-as-its-own-process.md) — owns the creation of these internal nodes.
