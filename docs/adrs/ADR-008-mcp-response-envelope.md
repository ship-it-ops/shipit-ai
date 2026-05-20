# ADR-008: MCP Response Envelope Standard

## Status

Accepted

## Date

2026-02-28

## Context

MCP tool responses in ShipIt-AI currently return domain data directly with no metadata. When an AI agent calls `blast_radius` or `dependency_chain`, it receives raw graph data but has no way to assess:

- **Data freshness:** Is this data from 5 seconds ago or 5 hours ago? During an incident, stale data can lead to wrong actions -- an engineer might ignore a service that was recently added to the dependency graph but has not yet been synced.
- **Result completeness:** Was the result truncated? Are there more nodes beyond what was returned? Without pagination metadata, the agent cannot know if it is seeing the full picture.
- **Data confidence:** Was ownership sourced from a single connector (e.g., only Backstage) or corroborated by multiple sources? Single-source data is less reliable.
- **Follow-up context:** What related tools should the agent call next? Without hints, agents either stop too early (missing critical context) or make redundant calls.

Additionally, AI agent tool-call budgets are limited. A typical agent chain has a context window constraint of roughly 128K tokens. If each MCP response is unbounded, a single blast_radius query returning hundreds of nodes could consume the entire budget, leaving no room for follow-up reasoning. Response size must be predictable and controllable.

Error handling is also inconsistent. Some tools return HTTP-style errors, others return free-text messages, and some simply time out. AI agents need a predictable error schema to handle failures programmatically.

## Decision

We will wrap every MCP tool response in a standard envelope that provides metadata alongside the domain result. All MCP tools must conform to this envelope format.

### Standard Response Envelope

```json
{
  "_meta": {
    "tool": "blast_radius",
    "execution_time_ms": 340,
    "data_freshness": {
      "oldest_node_sync": "2026-02-28T02:15:00Z",
      "freshness_status": "healthy"
    },
    "truncated": false,
    "next_cursor": null,
    "result_count": 6,
    "total_available": 6,
    "warnings": [],
    "suggested_follow_up": ["find_owners", "entity_detail"]
  },
  "result": { ... }
}
```

### Field Specifications

**`_meta.tool`** (string, required): The tool name that produced this response. Enables agents to correlate responses in multi-tool chains.

**`_meta.execution_time_ms`** (integer, required): Wall-clock execution time in milliseconds. Useful for performance monitoring and detecting degraded Neo4j performance.

**`_meta.data_freshness`** (object, required):

- `oldest_node_sync` (ISO 8601 timestamp): The oldest `_last_synced_at` timestamp among all nodes in the result set. This represents the worst-case data age.
- `freshness_status` (enum: `healthy` | `stale` | `degraded`):
  - `healthy`: All nodes synced within the last 15 minutes.
  - `stale`: At least one node has not synced in the last 15 minutes but less than 1 hour.
  - `degraded`: At least one node has not synced in over 1 hour, or the sync timestamp is missing.

**`_meta.truncated`** (boolean, required): `true` if the result set was limited by the default or requested limit and more data is available.

**`_meta.next_cursor`** (string, nullable): An opaque cursor for fetching the next page of results. `null` if no more results are available.

**`_meta.result_count`** (integer, required): Number of items in the current response's `result` field.

**`_meta.total_available`** (integer, required): Total number of items matching the query, regardless of pagination. Enables agents to decide whether to paginate.

**`_meta.warnings`** (array of objects, required): Each warning has the structure:

```json
{
  "code": "STALE_DATA",
  "message": "Node 'payment-service' last synced 47 minutes ago.",
  "severity": "warn",
  "affected_nodes": ["payment-service"]
}
```

Warning codes include:

- `STALE_DATA`: One or more nodes have not been synced recently.
- `SINGLE_SOURCE`: Data (e.g., ownership) sourced from only one connector with no corroboration. Example: "Ownership of payment-service sourced only from Backstage catalog."
- `CONFLICTING_CLAIMS`: Multiple connectors disagree on a property value. Example: "Tier classification differs between Backstage (tier-1) and PagerDuty (tier-2)."
- `LOW_CONFIDENCE`: Identity resolution matched entities with a confidence score below 0.90 (but above the merge threshold of 0.85).
- `PARTIAL_RESULT`: Some portion of the graph could not be traversed (e.g., a connector's data is missing entirely).

**`_meta.suggested_follow_up`** (array of strings, required): Tool names that would provide useful additional context given the current result. Agents can use these as hints for multi-hop reasoning chains.

### Standard Error Response

All errors use a consistent schema, returned instead of the envelope:

```json
{
  "error": {
    "code": "GRAPH_UNAVAILABLE",
    "message": "Knowledge graph is temporarily unavailable.",
    "suggestions": ["Retry in 30 seconds", "Check system health at /health"]
  }
}
```

Error codes:

- `GRAPH_UNAVAILABLE`: Neo4j is unreachable (see ADR-007).
- `INVALID_QUERY`: The tool received invalid parameters.
- `ENTITY_NOT_FOUND`: The requested entity does not exist in the graph.
- `TIMEOUT`: The query exceeded the configured timeout (default: 10 seconds).
- `INTERNAL_ERROR`: An unexpected server error occurred.

### Default Result Limits Per Tool

To keep responses within a predictable token budget (~4000 tokens per tool call), the following default limits apply:

| Tool               | Default Limit   | Max Allowed |
| ------------------ | --------------- | ----------- |
| `blast_radius`     | 20 nodes        | 100 nodes   |
| `dependency_chain` | 10 paths        | 50 paths    |
| `semantic_search`  | 10 results      | 50 results  |
| `find_owners`      | 10 owners       | 50 owners   |
| `entity_detail`    | 1 entity (full) | 1 entity    |
| `schema_info`      | Full schema     | Full schema |

All tools accept an optional `limit` parameter to override the default, up to the max allowed.

### Compact Mode

All tools accept an optional `compact` parameter (boolean, default: `false`). When `compact=true`, node representations are reduced to only:

```json
{
  "id": "neo4j-internal-id",
  "label": "LogicalService",
  "name": "payment-service",
  "tier_effective": "tier-1"
}
```

This mode is designed for multi-hop agent chains where intermediate results are used for follow-up queries rather than direct presentation to users. Compact mode typically reduces response size by 60-80%.

## Consequences

### Positive

- **AI agents can make informed decisions about data quality.** Freshness status and warnings enable agents to caveat their recommendations during incidents ("Note: ownership data for payment-service is from a single source and may be incomplete").
- **Predictable response sizes.** Default limits and the ~4000 token budget prevent any single tool call from consuming the agent's context window, enabling reliable multi-hop reasoning chains.
- **Pagination support.** Agents can iteratively fetch large result sets when needed, rather than receiving an overwhelming or truncated response with no indication of what was missed.
- **Consistent error handling.** A single error schema across all tools simplifies agent error-handling logic and enables automatic retry strategies.
- **Compact mode enables efficient multi-hop chains.** An agent can call `blast_radius(compact=true)` to get a list of affected services, then call `find_owners` for just the tier-1 services, staying within token budget.
- **Follow-up suggestions reduce wasted tool calls.** Agents can follow the suggested tools rather than guessing, improving both efficiency and result quality.

### Negative

- **Increased response payload size.** The `_meta` envelope adds approximately 200-400 bytes per response. For simple queries, this overhead is proportionally larger. Mitigated by the fact that even with overhead, responses stay within the 4000-token budget.
- **Implementation effort.** Every MCP tool must be updated to produce the envelope format. New tools must conform from the start. This requires a shared response-building utility in the MCP server codebase.
- **Freshness calculation has a cost.** Computing `oldest_node_sync` requires scanning `_last_synced_at` on all result nodes. For large result sets, this adds latency. Mitigated by indexing `_last_synced_at` in Neo4j and computing the minimum during the primary query.
- **Warning generation complexity.** Detecting single-source data and conflicting claims requires additional graph queries or cached metadata. This logic must be maintained as new connectors are added.
- **Versioning risk.** If the envelope schema changes, all MCP tool clients (AI agents, UI) must be updated. Mitigated by treating `_meta` as additive-only (new fields can be added but existing fields are never removed or renamed).

## Alternatives Considered

### Alternative 1: Return Raw Data with Optional Metadata Header

- **Description:** Keep the current raw response format and add metadata only when the client requests it via an `include_meta=true` parameter.
- **Rejected because:** Metadata is not optional information -- it is critical for AI agent decision-making. Making it opt-in means most agents will not request it, leading to uninformed decisions. The envelope should be the default, always-on contract.

### Alternative 2: Use HTTP Headers for Metadata

- **Description:** Return metadata via custom HTTP headers (e.g., `X-Data-Freshness`, `X-Truncated`, `X-Total-Count`) and keep the response body as raw data.
- **Rejected because:** MCP tool responses are not HTTP responses -- they are structured tool outputs consumed by AI agents via the MCP protocol. HTTP headers are not part of the MCP tool response model. Additionally, AI agents cannot easily inspect transport-layer headers; they operate on the structured response body.

### Alternative 3: Separate Metadata Endpoint

- **Description:** Provide a separate `query_metadata` tool that returns freshness, warnings, and pagination info for a given query ID.
- **Rejected because:** This doubles the number of tool calls required, consuming agent tool-call budget and adding latency. Metadata is most useful when it is co-located with the data it describes, not fetched separately.

### Alternative 4: No Pagination, Return Everything

- **Description:** Always return the full result set without limits or pagination.
- **Rejected because:** A blast radius query on a tier-1 service in a large organization could return hundreds of nodes, easily exceeding 50,000 tokens. This would consume the agent's entire context window in a single tool call, preventing any follow-up reasoning. Predictable, bounded response sizes are essential for reliable agent behavior.
