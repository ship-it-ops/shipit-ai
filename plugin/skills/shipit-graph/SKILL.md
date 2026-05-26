---
name: shipit-graph
description: Use when the user asks about services, owners, teams, dependencies, blast radius, ownership chains, or anything in the ShipIt-AI knowledge graph. Routes the request to the right MCP tool instead of defaulting to ad-hoc Cypher.
---

# Using the ShipIt-AI knowledge graph

The user runs ShipIt-AI — a knowledge graph of services, teams, repos, deployments, owners, and on-call schedules backed by Neo4j and exposed via 8 MCP tools. **Always prefer a structured tool over raw Cypher.** A structured tool is bounded, paginated, and returns metadata the agent can use; raw Cypher (`graph_query`) is the last resort.

## Decision tree — pick the smallest tool that answers the question

| The user wants to know…                              | Use                                                    |
| ---------------------------------------------------- | ------------------------------------------------------ |
| Everything affected if X breaks / changes            | `blast_radius`                                         |
| One entity's properties, claims, and 1-hop neighbors | `entity_detail`                                        |
| The schema (node types, properties, relationships)   | `schema_info`                                          |
| Who owns / maintains / is on-call for X              | `find_owners`                                          |
| The shortest dependency path between two entities    | `dependency_chain`                                     |
| Overall counts, environments, freshness              | `graph_stats`                                          |
| Find entities by label or property filter            | `search_entities`                                      |
| Anything the above can't express                     | `graph_query` (read the **shipit-cypher** skill first) |

If the user's question maps to more than one tool, prefer the one that's narrowest. Example: "what services depend on payments-api?" → `blast_radius` with `direction: UPSTREAM`, not `graph_query`.

## Canonical IDs

Every entity has an ID of the form `shipit://{label-in-kebab-case}/default/{name}`. Examples from the test fixtures:

- `shipit://logical-service/default/payments-api`
- `shipit://repository/default/payments-api`
- `shipit://deployment/default/payments-api-prod`
- `shipit://team/default/payments-platform`
- `shipit://person/default/alice`
- `shipit://pipeline/default/payments-api-cd`
- `shipit://monitor/default/payments-api-p99`

If the user gives you a bare name ("payments-api"), don't guess the label — call `search_entities` with `label: "LogicalService"` (or the label most likely to match) and confirm the canonical ID before drilling in. **Never invent an ID** — the server will return `NODE_NOT_FOUND` with `suggestions[]` if you're close but wrong (see **shipit-debugging**).

## Response envelope

Every tool returns:

```jsonc
{
  "_meta": {
    "tool": "blast_radius",
    "version": "1.0",
    "query_time_ms": 42,
    "node_count": 12,
    "truncated": false,
    "data_quality": { "stale_nodes": 0, "single_source_nodes": 3 },
    "cache_hit": false,
    "warnings": [],
    "suggested_follow_up": ["Try entity_detail for node X"],
    "next_cursor": null,
  },
  "data": {
    /* tool-specific result */
  },
}
```

Always check the `_meta` fields before continuing:

- `truncated: true` → the response hit a server-side cap. Re-call with a tighter filter (`include_environments`, `production_only`, a more specific `label`) or follow `next_cursor`.
- `data_quality.stale_nodes > 0` → some data is older than the connector freshness threshold. Mention it to the user instead of presenting stale facts as fresh.
- `suggested_follow_up[]` → the server has hinted at the next useful call. If your plan was about to do the same thing, just follow the hint.

Pass `compact: true` only when you're going to throw away `_meta` anyway — e.g. a one-shot lookup whose result you'll inline into a sentence. Default to `compact: false` so you keep the metadata.

## Common patterns

**"What's the blast radius of changing X?"** → `blast_radius` with `node: <canonical id>`, default `direction: DOWNSTREAM`, `depth: 3`. For prod impact only, add `production_only: true`.

**"Who do I page if X goes down?"** → `find_owners` with `entity: <canonical id>`, `include_chain: true`. Look at `on_call[]` first, then `owners[]`.

**"How does service A depend on service B?"** → `dependency_chain` with `from: A, to: B`. If no path comes back, the services aren't related through any dependency edge — say so plainly instead of trying `graph_query`.

**"Show me all tier-1 services in production"** → `search_entities` with `label: "LogicalService"`, `property_filters: { "tier_effective": 1 }`. Then if the user drills into one, switch to `entity_detail`.

**"How healthy is the graph right now?"** → `graph_stats` (no params). Surface `total_nodes`, `freshness_summary`, top labels by count.

## Don't

- Don't write Cypher when a structured tool fits — it bypasses guardrails, returns larger payloads, and is harder to reason about.
- Don't ignore `truncated: true` — silently presenting partial data as complete misleads the user.
- Don't call tools in parallel that depend on each other's output (e.g. don't call `entity_detail` before you've resolved the canonical ID via `search_entities`).
- Don't try writes — these are read-only tools and `graph_query` will reject any keyword that mutates state.
