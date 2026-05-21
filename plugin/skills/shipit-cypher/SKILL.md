---
name: shipit-cypher
description: Use before writing or refining a Cypher query for the ShipIt-AI `graph_query` MCP tool. Covers the read-only guardrails, hop and row limits, parameter binding, and patterns the server's safety scanner rejects.
---

# Writing Cypher against the ShipIt-AI graph

`graph_query` is the escape hatch for queries the structured tools can't express. It's gated by a safety scanner and several runtime caps; calls that violate them are rejected before they reach Neo4j. **Read the shipit-graph skill first** — most of the time you don't need Cypher at all.

## Hard guardrails

1. **Read-only.** The server rejects any query containing `MERGE`, `CREATE`, `DELETE`, `DETACH`, `SET`, `REMOVE`, `DROP`, or `CALL{}` subqueries (regex-matched, case-insensitive). Trying to mutate state returns `INVALID_PARAMETER` with a message naming the keyword.

2. **Hop limit.** Variable-length patterns like `()-[*..N]->()` are capped at **N ≤ 6** by default. Going higher returns `HOP_LIMIT_EXCEEDED`. If you need a longer path, switch to `dependency_chain` (which can do up to 10 hops as a typed traversal).

3. **Row limit.** Default 1000 rows per response. Anything beyond truncates with `_meta.truncated: true`. Filter harder or paginate via `next_cursor` rather than asking for the whole graph.

4. **Query timeout.** 10 s default. If you hit `QUERY_TIMEOUT`, your query is doing a Cartesian or unindexed scan — usually means missing a label filter or a starting node.

5. **Always parameterize.** Pass values via the `params` object, never via string concatenation. The schema scanner doesn't blocklist injection patterns, but parameterization keeps the query plan cacheable and the error messages legible.

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
