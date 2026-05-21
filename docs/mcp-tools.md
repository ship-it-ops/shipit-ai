# MCP Tools

> **In the app:** Configure → MCP Access (`/configure/mcp`) surfaces the connection snippets and tool catalog in a copy-paste friendly form. This doc is the canonical reference for parameters and response shapes.

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

| Parameter              | Type     | Required | Default      | Description                                                                     |
| ---------------------- | -------- | -------- | ------------ | ------------------------------------------------------------------------------- |
| `node`                 | string   | yes      | —            | Starting node canonical ID (e.g., `shipit://repository/default/config-service`) |
| `depth`                | integer  | no       | 3            | Max traversal hops (1-6)                                                        |
| `direction`            | enum     | no       | `DOWNSTREAM` | `DOWNSTREAM`, `UPSTREAM`, or `BOTH`                                             |
| `include_environments` | string[] | no       | —            | Filter deployments by environment name                                          |
| `production_only`      | boolean  | no       | false        | Shorthand for `include_environments: ["production"]`                            |
| `compact`              | boolean  | no       | false        | Strip `_meta` envelope                                                          |

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

| Parameter           | Type    | Required | Default | Description                                         |
| ------------------- | ------- | -------- | ------- | --------------------------------------------------- |
| `entity`            | string  | yes      | —       | Entity canonical ID                                 |
| `include_claims`    | boolean | no       | false   | Return all PropertyClaims for each property         |
| `include_neighbors` | boolean | no       | true    | Return 1-hop neighbors grouped by relationship type |
| `compact`           | boolean | no       | false   | Strip `_meta` envelope                              |

**Response:**

```json
{
  "data": {
    "node": {
      "id": "shipit://logicalservice/default/config-service",
      "label": "LogicalService",
      "properties": { "name": "config-service", "tier": 1, "owner": "platform-team" },
      "effective_properties": { ... }
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

| Parameter       | Type    | Required | Default | Description                                               |
| --------------- | ------- | -------- | ------- | --------------------------------------------------------- |
| `entity`        | string  | yes      | —       | Entity canonical ID                                       |
| `include_chain` | boolean | no       | false   | Return full ownership chain (CODEOWNERS → Team → Members) |
| `compact`       | boolean | no       | false   | Strip `_meta` envelope                                    |

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

| Parameter   | Type    | Required | Default | Description              |
| ----------- | ------- | -------- | ------- | ------------------------ |
| `from`      | string  | yes      | —       | Source node canonical ID |
| `to`        | string  | yes      | —       | Target node canonical ID |
| `max_depth` | integer | no       | 6       | Max path length (1-10)   |
| `compact`   | boolean | no       | false   | Strip `_meta` envelope   |

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

| Parameter          | Type    | Required | Default  | Description                                               |
| ------------------ | ------- | -------- | -------- | --------------------------------------------------------- |
| `label`            | string  | no       | —        | Filter by node label (e.g., `"LogicalService"`)           |
| `property_filters` | object  | no       | —        | Filter by property values (e.g., `{"tier_effective": 1}`) |
| `limit`            | integer | no       | 25       | Max results (1-100)                                       |
| `sort_by`          | string  | no       | `"name"` | Property to sort by                                       |
| `compact`          | boolean | no       | false    | Strip `_meta` envelope                                    |

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

| Parameter | Type | Required | Default | Description |
| --------- | ---- | -------- | ------- | ----------- |
| _(none)_  | —    | —        | —       | —           |

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

| Parameter | Type    | Required | Default | Description                                     |
| --------- | ------- | -------- | ------- | ----------------------------------------------- |
| `query`   | string  | yes      | —       | Cypher query (must be read-only, parameterized) |
| `params`  | object  | no       | —       | Query parameters                                |
| `compact` | boolean | no       | false   | Strip `_meta` envelope                          |

**Guardrails:**

- Write operations are rejected (`MERGE`, `CREATE`, `DELETE`, `SET`, `REMOVE`, `DROP`, `CALL{}`)
- Variable-length patterns limited to 6 hops (configurable via `MCP_HOP_LIMIT`)
- Results capped at 1000 rows (configurable via `MCP_ROW_LIMIT`)
- Queries timeout after 10 seconds (configurable via `MCP_QUERY_TIMEOUT_MS`)
- Rate limited to 100 calls per day (configurable via `MCP_GRAPH_QUERY_LIMIT`)

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
| `ROW_LIMIT_EXCEEDED`   | Results exceeded row limit                                                       |
| `RATE_LIMIT_EXCEEDED`  | Daily rate limit exceeded                                                        |
| `RBAC_DENIED`          | Access denied                                                                    |
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
