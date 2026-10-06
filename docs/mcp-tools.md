# MCP Tools

> **In the app:** AI → MCP Access (`/ai/mcp`) surfaces the connection snippets and tool catalog in a copy-paste friendly form. This doc is the canonical reference for parameters and response shapes.

ShipIt-AI exposes the knowledge graph to AI agents via the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/). The MCP server connects directly to Neo4j and provides 8 tools for querying the graph.

## Connecting to the MCP Server

The MCP server uses stdio transport. Configure it in your MCP client:

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "shipit-ai": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js"],
      "cwd": "/path/to/ShipIt-AI",
      "env": {
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USER": "neo4j",
        "NEO4J_PASSWORD": "shipit-dev"
      }
    }
  }
}
```

### Claude Code

Add to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "shipit-ai": {
      "command": "node",
      "args": ["packages/mcp-server/dist/index.js"],
      "cwd": "/path/to/ShipIt-AI",
      "env": {
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USER": "neo4j",
        "NEO4J_PASSWORD": "shipit-dev"
      }
    }
  }
}
```

## Response Envelope

All tools wrap responses in a standard envelope (unless `compact: true` is passed):

```json
{
  "_meta": {
    "tool": "blast_radius",
    "version": "1.0",
    "query_time_ms": 42,
    "node_count": 12,
    "truncated": false,
    "data_quality": {
      "stale_nodes": 0,
      "single_source_nodes": 3
    },
    "cache_hit": false,
    "warnings": [],
    "suggested_follow_up": ["Try entity_detail for node X"],
    "next_cursor": null
  },
  "data": { ... }
}
```

All tools accept a `compact` boolean parameter (default `false`) to strip the `_meta` envelope and return just the `data` object.

## Tool Reference

### `blast_radius`

Analyze downstream/upstream impact of a node in the knowledge graph. Returns affected nodes, paths, and summary statistics.

| Parameter              | Type     | Required | Default      | Description                                                                            |
| ---------------------- | -------- | -------- | ------------ | -------------------------------------------------------------------------------------- |
| `node`                 | string   | yes      | —            | Starting node canonical ID (e.g., `shipit://repository/default/config-service`)        |
| `depth`                | integer  | no       | 3            | Max traversal hops (1-6)                                                               |
| `direction`            | enum     | no       | `DOWNSTREAM` | `DOWNSTREAM`, `UPSTREAM`, or `BOTH`                                                    |
| `include_environments` | string[] | no       | —            | Filter deployments by environment name                                                 |
| `production_only`      | boolean  | no       | false        | Shorthand for `include_environments: ["production"]`                                   |
| `include_absent`       | boolean  | no       | false        | Include entities the owning connector no longer sees (marked absent by the sync sweep) |
| `compact`              | boolean  | no       | false        | Strip `_meta` envelope                                                                 |

**Response:**

```json
{
  "data": {
    "affected_nodes": [...],
    "paths": [...],
    "summary": {
      "total_services": 5,
      "total_teams": 2,
      "tier1_count": 1
    }
  }
}
```

---

### `entity_detail`

Get detailed information about a single entity including properties, claims, and neighbors.

Looking an entity up by id always returns it, even once the sync sweep has marked
it absent — `absent_since` on the returned node carries the sweep timestamp (and is
`null` for a live entity), so a deleted workload never reads as still deployed.
`include_absent` governs the **neighbors**.

| Parameter           | Type    | Required | Default | Description                                                                            |
| ------------------- | ------- | -------- | ------- | -------------------------------------------------------------------------------------- |
| `entity`            | string  | yes      | —       | Entity canonical ID                                                                    |
| `include_claims`    | boolean | no       | false   | Return all PropertyClaims for each property                                            |
| `include_neighbors` | boolean | no       | true    | Return 1-hop neighbors grouped by relationship type                                    |
| `include_absent`    | boolean | no       | false   | Include entities the owning connector no longer sees (marked absent by the sync sweep) |
| `compact`           | boolean | no       | false   | Strip `_meta` envelope                                                                 |

**Response:**

```json
{
  "data": {
    "node": {
      "id": "shipit://logicalservice/default/config-service",
      "label": "LogicalService",
      "properties": { "name": "config-service", "tier": 1, "owner": "platform-team" },
      "effective_properties": { ... },
      "absent_since": null
    },
    "claims": [...],
    "neighbors": {
      "IMPLEMENTED_BY": [...],
      "DEPLOYED_AS": [...],
      "OWNS": [...]
    }
  }
}
```

---

### `find_owners`

Find owners, code owners, and on-call personnel for an entity. Traverses `OWNS`, `CODEOWNER_OF`, `MEMBER_OF`, and `ON_CALL_FOR` relationships.

| Parameter        | Type    | Required | Default | Description                                                                            |
| ---------------- | ------- | -------- | ------- | -------------------------------------------------------------------------------------- |
| `entity`         | string  | yes      | —       | Entity canonical ID                                                                    |
| `include_chain`  | boolean | no       | false   | Return full ownership chain (CODEOWNERS → Team → Members)                              |
| `include_absent` | boolean | no       | false   | Include entities the owning connector no longer sees (marked absent by the sync sweep) |
| `compact`        | boolean | no       | false   | Strip `_meta` envelope                                                                 |

**Response:**

```json
{
  "data": {
    "owners": [{ "id": "...", "label": "Team", "name": "platform-team" }],
    "codeowners": [...],
    "on_call": [...],
    "members": [...]
  }
}
```

---

### `dependency_chain`

Find the shortest dependency path between two entities in the knowledge graph.

| Parameter        | Type    | Required | Default | Description                                                                            |
| ---------------- | ------- | -------- | ------- | -------------------------------------------------------------------------------------- |
| `from`           | string  | yes      | —       | Source node canonical ID                                                               |
| `to`             | string  | yes      | —       | Target node canonical ID                                                               |
| `max_depth`      | integer | no       | 6       | Max path length (1-10)                                                                 |
| `include_absent` | boolean | no       | false   | Include entities the owning connector no longer sees (marked absent by the sync sweep) |
| `compact`        | boolean | no       | false   | Strip `_meta` envelope                                                                 |

**Response:**

```json
{
  "data": {
    "paths": [[...node_ids...]],
    "shortest_path_length": 3,
    "total_paths_found": 2
  }
}
```

---

### `search_entities`

Search and filter entities in the knowledge graph by label and property values.

| Parameter          | Type    | Required | Default  | Description                                                                            |
| ------------------ | ------- | -------- | -------- | -------------------------------------------------------------------------------------- |
| `label`            | string  | no       | —        | Filter by node label (e.g., `"LogicalService"`)                                        |
| `property_filters` | object  | no       | —        | Filter by property values (e.g., `{"tier_effective": 1}`)                              |
| `limit`            | integer | no       | 25       | Max results (1-100)                                                                    |
| `sort_by`          | string  | no       | `"name"` | Property to sort by                                                                    |
| `include_absent`   | boolean | no       | false    | Include entities the owning connector no longer sees (marked absent by the sync sweep) |
| `compact`          | boolean | no       | false    | Strip `_meta` envelope                                                                 |

`label`, `sort_by` and the keys of `property_filters` are written into the query as
identifiers, so each must be a plain identifier: letters, digits and underscores, not
starting with a digit, at most 64 characters. A label must start with a letter. Anything
else is refused before a query runs.

Nodes whose label starts with an underscore are the application's own bookkeeping and
not part of the catalog. No structured tool starts from one, lists one or counts one:
`search_entities`, `graph_stats` and `schema_info` leave them out, `entity_detail`,
`find_owners` and `blast_radius` answer "not found" for the id of one, and
`dependency_chain` finds no path from or to one. They carry no relationships, so a
traversal has none to reach; the neighbors of `entity_detail` and the paths of
`dependency_chain` exclude them all the same.

**Response:**

```json
{
  "data": {
    "entities": [...],
    "total_matching": 42,
    "returned": 25
  }
}
```

---

### `graph_stats`

Return aggregate statistics about the knowledge graph.

| Parameter        | Type    | Required | Default | Description                                                                            |
| ---------------- | ------- | -------- | ------- | -------------------------------------------------------------------------------------- |
| `include_absent` | boolean | no       | false   | Include entities the owning connector no longer sees (marked absent by the sync sweep) |

**Response:**

```json
{
  "data": {
    "node_counts_by_label": { "LogicalService": 15, "Repository": 42, ... },
    "edge_counts_by_type": { "IMPLEMENTED_BY": 15, "DEPENDS_ON": 30, ... },
    "environments": ["production", "staging", "development"],
    "total_nodes": 200,
    "total_edges": 350,
    "freshness_summary": { ... }
  }
}
```

---

### `schema_info`

Return the current graph schema: node types with property definitions and resolution strategies, relationship types with direction and cardinality.

| Parameter | Type | Required | Default | Description |
| --------- | ---- | -------- | ------- | ----------- |
| _(none)_  | —    | —        | —       | —           |

**Response:**

```json
{
  "data": {
    "node_types": {
      "LogicalService": {
        "description": "A named, team-owned service concept",
        "properties": { ... },
        "constraints": { "unique_key": "name" }
      },
      ...
    },
    "relationship_types": {
      "DEPENDS_ON": { "from": "LogicalService", "to": "LogicalService", "cardinality": "N:M" },
      ...
    }
  }
}
```

---

### `graph_query`

Execute a raw Cypher query against the knowledge graph. **Read-only queries only.**

A raw query reads everything in the graph, the application's own records included, so over
HTTP the token must carry the `graph:query` scope as well as `mcp:invoke`. Only an
administrator holds that capability, so only an administrator can mint such a token (Settings →
API Keys). A call without it is refused with `RBAC_DENIED`. Over stdio there is no token: that
is the operator's own trust.

| Parameter | Type    | Required | Default | Description                                     |
| --------- | ------- | -------- | ------- | ----------------------------------------------- |
| `query`   | string  | yes      | —       | Cypher query (must be read-only, parameterized) |
| `params`  | object  | no       | —       | Query parameters                                |
| `compact` | boolean | no       | false   | Strip `_meta` envelope                          |

**Guardrails:**

- The query text passes the read-only check the Query Playground also applies, before anything
  reaches the database. A query it refuses comes back as `INVALID_PARAMETER`, with the reason.
  - Clauses that write, change the schema, administer the database or import data are refused:
    `CREATE`, `MERGE`, `SET`, `REMOVE`, `DELETE`, `FOREACH`, `LOAD CSV`, `DROP`, `SHOW`, `USE`,
    `CALL { } IN TRANSACTIONS` and the rest of those families. A label or property that has one of
    these names must be quoted in backticks.
  - `CALL` is for subqueries and for these read procedures: `db.labels`, `db.relationshipTypes`,
    `db.propertyKeys`, `db.schema.visualization`, `db.schema.nodeTypeProperties`,
    `db.schema.relTypeProperties`, `apoc.path.expand`, `apoc.path.expandConfig`,
    `apoc.path.spanningTree`, `apoc.path.subgraphAll`, `apoc.path.subgraphNodes`. Every other
    procedure is refused.
  - Functions without a namespace (`toUpper`, `size`, `datetime`, …) are allowed. Of the namespaced
    ones, the date, time, duration, point and vector functions are, and so are
    `apoc.convert.fromJsonList` and `apoc.convert.fromJsonMap`. Every other namespaced function is
    refused.
  - Outside strings, backtick-quoted names and comments, the query must be plain ASCII. Unicode
    escape sequences (a backslash and a `u`) are refused anywhere; pass such values as parameters.
    Put a space before a parameter that follows a name.
  - One statement per call, of at most 100,000 characters, with no leading `CYPHER` options block.
  - A name that starts with an underscore is read as an internal label (the application's own
    bookkeeping) and refused, unless it is a property (`n._last_synced`) or a map key. A label
    chosen when the query runs (`$(...)`) is refused too.
- The query runs in a read-only transaction that is always rolled back, so the database itself
  refuses a write.
- An internal node in a result, or a path through one, comes back as `null`, with a note in
  `_meta.warnings`.
- Each server process runs at most four raw queries at a time. One more is refused with
  `SERVER_BUSY` until a place is free; wait and send it again.
- Every variable-length pattern needs an upper bound of at most 6 hops (configurable via
  `MCP_HOP_LIMIT`): `[*..6]`, `[*1..6]`, `[*3]`, `((a)-[]->(b)){1,6}`. A pattern with no upper
  bound (`[*]`, `[*2..]`, `{3,}`) is refused.
- Results capped at 1000 rows (configurable via `MCP_ROW_LIMIT`), whatever `LIMIT` the query
  carries; `_meta.truncated` says when rows were cut. A result may also hold at most 100,000
  values, counting every list item and map entry; a larger one is refused with
  `ROW_LIMIT_EXCEEDED`.
- Queries timeout after 10 seconds (configurable via `MCP_QUERY_TIMEOUT_MS`)
- 100 calls per token owner per UTC day (configurable via `MCP_GRAPH_QUERY_LIMIT`), counted in
  memory by each server process, so the count starts again when the process does

**Example:**

```json
{
  "query": "MATCH (s:LogicalService)-[:DEPENDS_ON]->(d:LogicalService) WHERE s.name_effective = $name RETURN d.name_effective AS dependency",
  "params": { "name": "config-service" }
}
```

**Response:**

```json
{
  "data": {
    "rows": [{ "dependency": "auth-service" }, { "dependency": "db-proxy" }],
    "row_count": 2
  }
}
```

## Error Codes

| Code                   | Description                                                                      |
| ---------------------- | -------------------------------------------------------------------------------- |
| `NODE_NOT_FOUND`       | Entity not found (includes "did you mean?" suggestions via Levenshtein distance) |
| `INVALID_CANONICAL_ID` | Malformed canonical ID format                                                    |
| `INVALID_PARAMETER`    | Invalid parameter value                                                          |
| `DEPTH_EXCEEDED`       | Requested depth exceeds maximum                                                  |
| `HOP_LIMIT_EXCEEDED`   | Cypher pattern exceeds hop limit                                                 |
| `QUERY_TIMEOUT`        | Query exceeded timeout                                                           |
| `ROW_LIMIT_EXCEEDED`   | The result has more rows, or more values, than a result may hold                 |
| `RATE_LIMIT_EXCEEDED`  | Daily rate limit exceeded                                                        |
| `SERVER_BUSY`          | Too many raw queries are running at once; retry shortly                          |
| `RBAC_DENIED`          | The token lacks a scope the tool needs (`graph:query` for `graph_query`)         |
| `TOOL_NOT_AVAILABLE`   | Tool is not available                                                            |
| `INTERNAL_ERROR`       | Unexpected server error                                                          |

## Configuration

| Environment Variable    | Default                 | Description                          |
| ----------------------- | ----------------------- | ------------------------------------ |
| `NEO4J_URI`             | `bolt://localhost:7687` | Neo4j connection URI                 |
| `NEO4J_USER`            | `neo4j`                 | Neo4j username                       |
| `NEO4J_PASSWORD`        | —                       | Neo4j password                       |
| `MCP_API_KEY_SECRET`    | _(none)_                | Optional API key for authentication  |
| `MCP_GRAPH_QUERY_LIMIT` | `100`                   | `graph_query` calls per day          |
| `MCP_ROW_LIMIT`         | `1000`                  | Max rows per `graph_query`           |
| `MCP_HOP_LIMIT`         | `6`                     | Max hops in variable-length patterns |
| `MCP_QUERY_TIMEOUT_MS`  | `10000`                 | Query timeout in milliseconds        |
