# ADR-036: Caller-Written Cypher — One Read-Only Check, One Executor, Administrators Only

## Status

Accepted

## Date

2026-10-05

## Context

Two surfaces run Cypher that a caller wrote: the Query Playground (`POST /api/query`) and the `graph_query` MCP tool. Each had its own check on the text and its own way of running the query, and the two had drifted; both checks worked by listing what to refuse. The demo runs on a managed Neo4j whose server settings are not ours, and local development uses the Community edition, which has no per-role read restrictions, so the application carries this itself. A raw query also reads everything in the graph, the application's own records included.

## Decision

- **One check on the text** (`checkReadOnlyCypher`, `@shipit-ai/shared`). Cypher's clauses are a closed set: the ones that write, administer or import are refused by keyword. Procedures and namespaced functions are an open set: a short list is allowed and everything else refused. Text the check cannot split into the tokens the database will is refused (escape sequences, non-ASCII outside strings, a `$` or a number glued to a name, several statements, a leading `CYPHER` block). A name starting with an underscore is read as an internal label and refused except as a property or map key.
- **One executor** (`runReadOnlyQuery`, `@shipit-ai/mcp-server/cypher`): a read-access transaction that is always rolled back, so the database itself refuses writes; the timeout on the transaction; a row limit by stopping the read and a value limit on the result; internal nodes returned as `null`; at most four such queries per process at a time.
- **Administrators only.** `POST /api/query` needs the admin role or the `graph:query` capability; the web UI hides the Query Playground from members; `graph_query` over HTTP needs a token with the `graph:query` scope, which only an administrator can mint, and gets a daily budget per owner. Every variable-length pattern needs an upper bound of at most the hop limit.
- `graph_query` stays withheld from the product's own agents until the owner decides otherwise.

## Consequences

### Positive

- Neither surface can be the weaker door; a miss in the text check on a write is still refused by the database.
- An independent review compared the check's tokens with the server's own lexer; each of its findings is pinned by a test.

### Negative

- Procedures and functions not on the lists are refused, harmless ones included; adding one is a line.
- Members lose the Query Playground unless the capability is granted by role.
- The database ends a timed-out query between rows only; work inside a single row runs on, bounded by the concurrency limit.

### Neutral

- A database edition with per-role privileges would let these surfaces run as a restricted user, with this as the layer in front.

## Alternatives Considered

### Keep two checks and extend their deny-lists

- **Cons:** A list of unwanted names over an open set is never complete, and two copies drift.

### Ask the database to classify the query (`EXPLAIN`)

- **Cons:** The plan's format belongs to the server version and says nothing about functions.

## References

- `docs/agent/decisions/raw-cypher-read-only-guard.md`
- `packages/shared/src/cypher/read-only-guard.ts`, `packages/mcp-server/src/cypher/read-only-query.ts`, `docs/mcp-tools.md`
