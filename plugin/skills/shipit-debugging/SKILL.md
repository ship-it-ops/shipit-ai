---
name: shipit-debugging
description: Use when a ShipIt-AI MCP tool returns an error or unexpected empty result. Maps the error code to the right recovery action so you don't blindly retry or fall back to `graph_query`.
---

# Recovering from ShipIt-AI MCP errors

Errors come back with this shape:

```jsonc
{
  "error": {
    "code": "NODE_NOT_FOUND",
    "message": "...",
    "suggestions": ["Did you mean 'shipit://logical-service/default/payments-api'?"],
  },
}
```

`suggestions[]` is populated for fuzzy-match scenarios (typos, label confusion). When it's there, use it before re-asking the user.

## Error catalog and recovery

| Code                   | What it means                                                                            | What to do                                                                                                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_NOT_FOUND`       | The canonical ID doesn't exist in the graph.                                             | Read `suggestions[]` — the server runs a Levenshtein fuzzy match against real IDs and surfaces up to 3. If a suggestion looks right, retry with it. If not, call `search_entities` with a likely label + the bare name to locate the right ID. |
| `INVALID_CANONICAL_ID` | The ID is malformed (wrong scheme, missing segment).                                     | Re-check the format: `shipit://{label-kebab-case}/default/{name}`. Labels are kebab-cased (`logical-service`, not `LogicalService`).                                                                                                           |
| `INVALID_PARAMETER`    | A required param is missing or has the wrong shape. The message names the param.         | Re-read the tool's schema (the MCP catalog shows defaults and types). For `graph_query`, this often means a forbidden keyword (`MERGE`, `SET`, etc.) — switch to a structured tool.                                                            |
| `DEPTH_EXCEEDED`       | `blast_radius` or `dependency_chain` exceeded its `depth` / `max_depth` param.           | Either raise the depth (capped at 6 for blast_radius, 10 for dependency_chain) or split the query. If you're at the cap, the entities are genuinely far apart — surface that to the user instead of digging.                                   |
| `HOP_LIMIT_EXCEEDED`   | A variable-length Cypher pattern asked for more hops than the server allows (default 6). | Stop trying Cypher. Use `dependency_chain` (typed traversal) or `blast_radius` (bounded fan-out).                                                                                                                                              |
| `QUERY_TIMEOUT`        | The Cypher query took longer than `MCP_QUERY_TIMEOUT_MS` (default 10s).                  | Almost always means an unindexed scan. Add a label filter, anchor on a specific starting node by ID, or switch to a structured tool.                                                                                                           |
| `ROW_LIMIT_EXCEEDED`   | The result has more rows than the row limit (default 1000).                              | Don't blindly raise the limit — the user usually wants the _interesting_ rows. Add a tighter filter (`tier_effective`, `environment`, etc.) and paginate via `next_cursor` if you really need everything.                                      |
| `RATE_LIMIT_EXCEEDED`  | The per-day `graph_query` budget is spent.                                               | Structured tools have separate, looser budgets. Re-frame the question for `blast_radius` / `search_entities` / `entity_detail` and stop calling `graph_query`.                                                                                 |
| `RBAC_DENIED`          | The caller's token lacks scope for this tool.                                            | Stop and tell the user — they need to update token scopes via the app's Settings → API Keys (Stage 2). Today's stdio deployment doesn't hit this.                                                                                              |
| `TOOL_NOT_AVAILABLE`   | The tool was disabled on the server side.                                                | Tell the user; they can re-enable in `shipit.config.yaml`. Don't fall back to a less-suitable tool without flagging it.                                                                                                                        |
| `INTERNAL_ERROR`       | Server-side failure (usually transient).                                                 | Retry once with the same params. If it fails again, the user's stack is degraded — surface the message verbatim instead of guessing.                                                                                                           |

## Empty result vs. error

A tool that returns successfully but with empty `data` is **not** an error — it usually means the question is well-formed but the graph has nothing matching. Examples:

- `dependency_chain` with no path → the services aren't connected via dependency edges in this graph. Don't retry with a different tool; say so.
- `blast_radius` with `affected_nodes: []` → the starting node has no downstream/upstream within the depth. Bump depth before assuming the graph is wrong.
- `search_entities` with `[]` → your `property_filters` were too narrow or the label is wrong.

## When to escalate to the user

- Two consecutive errors with no useful `suggestions` or recovery path → ask the user to clarify the entity they meant.
- Any `RBAC_DENIED`, `TOOL_NOT_AVAILABLE`, `RATE_LIMIT_EXCEEDED` → these need an operator action; tell the user instead of trying to work around them.
- `INTERNAL_ERROR` twice in a row → the stack is unhealthy; surface and stop.

## Never

- Don't fall back to `graph_query` just because a structured tool errored — the structured tool is usually right and you're holding it wrong. Re-read its params first.
- Don't retry an exact same call more than once. The server is deterministic; the second call will fail the same way.
- Don't fabricate canonical IDs to make an error go away. If `NODE_NOT_FOUND` has no suggestions, the entity isn't there.
