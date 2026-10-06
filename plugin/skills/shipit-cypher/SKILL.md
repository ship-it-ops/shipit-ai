---
name: shipit-cypher
description: Use before writing or refining a Cypher query for the ShipIt-AI `graph_query` MCP tool. Covers the read-only guardrails, hop and row limits, parameter binding, and patterns the server's safety scanner rejects.
---

# Writing Cypher against the ShipIt-AI graph

`graph_query` is the escape hatch for queries the structured tools can't express. It's gated by a safety scanner and several runtime caps; calls that violate them are rejected before they reach Neo4j. **Read the shipit-graph skill first** — most of the time you don't need Cypher at all.

Over HTTP the tool also needs a token with the `graph:query` scope, which only an administrator can mint. `RBAC_DENIED` means the token lacks it: tell the user, do not retry.

## Hard guardrails

1. **Read-only.** The server refuses a query with a clause that writes, changes the schema, administers the database or imports data: `CREATE`, `MERGE`, `SET`, `REMOVE`, `DELETE`, `DETACH`, `FOREACH`, `LOAD CSV`, `DROP`, `SHOW`, `USE`, `CALL { } IN TRANSACTIONS` and their relatives. The words are matched as whole words, in any case, outside strings and comments. It returns `INVALID_PARAMETER` with a message naming the keyword. A label or property that happens to have one of these names must be quoted in backticks (``n.`set` ``).

   **Procedures and functions are allowed by name; everything else is refused.**
   - `CALL` works for subqueries (`CALL { ... }`, `CALL (x) { ... }`) and for `db.labels`, `db.relationshipTypes`, `db.propertyKeys`, `db.schema.visualization`, `db.schema.nodeTypeProperties`, `db.schema.relTypeProperties`, `apoc.path.expand`, `apoc.path.expandConfig`, `apoc.path.spanningTree`, `apoc.path.subgraphAll` and `apoc.path.subgraphNodes`.
   - Functions without a namespace (`toUpper`, `size`, `collect`, `datetime`, …) work. Of the namespaced ones, only the date, time, duration, point and vector functions do, plus `apoc.convert.fromJsonList` and `apoc.convert.fromJsonMap` (for the JSON in `_claims`). Do not reach for other `apoc.*` functions; use plain Cypher.

   **Plain text only.** Outside strings, backtick-quoted names and comments the query must be ASCII, and a Unicode escape (backslash, `u`) is refused anywhere. Send one statement per call, with no `CYPHER` options in front. Pass unusual values as parameters, and put a space before a parameter that follows a name.

   **Leave internal nodes alone.** Labels that start with an underscore are the application's own bookkeeping, not part of the catalog. A query that uses a name starting with an underscore is refused unless the name is a property (`n._last_synced`) or a map key; so is a label chosen at run time (`$(...)`). An internal node in a result comes back as `null`, with a note in `_meta.warnings`.

2. **Hop limit.** Every variable-length pattern needs an upper bound of **at most 6** by default: `[*..6]`, `[*1..6]`, `[*3]`, `((a)-[]->(b)){1,6}`. A pattern with no upper bound (`[*]`, `[*2..]`, `{3,}`), or one above the limit, returns `HOP_LIMIT_EXCEEDED`; that includes `shortestPath((a)-[*]-(b))`, which needs `[*..6]`. If you need a longer path, switch to `dependency_chain` (which can do up to 10 hops as a typed traversal).

3. **Row limit.** Default 1000 rows per response, whatever `LIMIT` the query carries. Anything beyond truncates with `_meta.truncated: true`. A result may also hold at most 100,000 values (every list item and map entry counts); a larger one is refused with `ROW_LIMIT_EXCEEDED`. Filter harder or paginate with `SKIP` and `LIMIT` rather than asking for the whole graph, and do not `collect()` the graph into one row.

4. **Query timeout.** 10 s default. If you hit `QUERY_TIMEOUT`, your query is doing a Cartesian or unindexed scan — usually means missing a label filter or a starting node. The server also runs only a few raw queries at a time: `SERVER_BUSY` means wait a moment and send the same query again, not rephrase it. Each token owner gets 100 `graph_query` calls per UTC day; `RATE_LIMIT_EXCEEDED` means the budget is spent.

5. **Always parameterize.** Pass values via the `params` object, never via string concatenation. It keeps the query plan cacheable and the error messages legible, and a value in a parameter is never mistaken for a clause.

## Good vs. bad

### ✅ Good

```cypher
// Tier-1 services in production with their owners
MATCH (s:LogicalService {tier_effective: 1})-[:DEPLOYED_AS]->(d:Deployment {environment: $env})
MATCH (s)<-[:OWNS]-(t:Team)
RETURN s.id AS service_id, s.name AS name, t.name AS team
LIMIT 50
```

Params: `{ "env": "production" }`. Starts from a labeled, filtered node. Bounded LIMIT. Returns flat scalar fields.

### ❌ Bad — unbounded

```cypher
MATCH (n)-[r*]->(m) RETURN n, r, m
```

No labels, no filter, unbounded path. Will hit `QUERY_TIMEOUT` and exhaust the row limit.

### ❌ Bad — write

```cypher
MATCH (s:LogicalService {id: $id}) SET s.tier_effective = 1 RETURN s
```

Will be rejected immediately by the safety scanner (`SET` keyword). Property changes are made through PropertyClaims, not direct writes.

### ❌ Bad — hop over the limit

```cypher
MATCH path = (a:LogicalService {id: $a})-[*..10]->(b:LogicalService {id: $b}) RETURN path
```

Hop limit is 6. Use `dependency_chain` instead.

## When to reach for Cypher vs. a structured tool

Reach for Cypher only when:

- The query crosses node types in a pattern no structured tool exposes (e.g. "deployments without a corresponding monitor").
- You need an aggregation the structured tools don't surface (e.g. count of stale claims per team).
- You're exploring the schema interactively for a one-off question and `schema_info` told you the shape.

Don't reach for Cypher when:

- You want neighbors of a node — use `entity_detail`.
- You want a path between two nodes — use `dependency_chain`.
- You want everything affected by a change — use `blast_radius`.
- You want to list nodes by property — use `search_entities`.

## Result shape

The response wraps the query result in the standard envelope (see **shipit-graph**). `data` is the raw record list from Neo4j; column names come from your `RETURN` clause. Always alias columns (`AS name`) — bare `RETURN n` returns a full node object that you then have to introspect.
