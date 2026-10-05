---
type: decision
status: active
created: 2026-10-05
updated: 2026-10-05
author: claude-session-2026-10-05-raw-cypher-hardening
tags: [security, cypher, neo4j, mcp, query-playground]
importance: core
---

# Caller-written Cypher: one text check, one executor, and what each is trusted for

## Context

Two surfaces run a Cypher string that someone else wrote: the Query Playground
(`POST /api/query`) and the `graph_query` MCP tool. Each had its own check on the text and its
own way of running the query, and the two had drifted: a rule in one was missing from the
other, and a limit the docs promised for one (the timeout) was never applied. Both checks
worked by listing what to refuse.

Two facts shape what is possible. The demo runs on a managed Neo4j whose server settings are
not ours to change. Local development and CI run the Community edition, which has no
per-role restrictions on what a database user can read or call. So the application has to
carry this by itself.

## Decision

**One check on the text**, `checkReadOnlyCypher` in `@shipit-ai/shared`
(`packages/shared/src/cypher/read-only-guard.ts`), used by both surfaces.

- Cypher's own clauses are a closed set, fixed by the language. The ones that write,
  administer or import are refused by name.
- Procedures and namespaced functions are an open set: every plugin adds more. A list of the
  unwanted ones can never be complete, so the wanted ones are listed and every other one is
  refused.
- The check reads text, so it must split the text into the tokens the database will. Where it
  cannot be sure of that it refuses: escape sequences the database decodes before reading the
  query, characters outside ASCII (except in strings, quoted names and comments), a number
  that runs into a name, more than one statement.

**One executor**, `runReadOnlyQuery` in `@shipit-ai/mcp-server`
(`packages/mcp-server/src/cypher/read-only-query.ts`, exported as
`@shipit-ai/mcp-server/cypher`), used by both surfaces.

- The transaction is opened for read access and is always rolled back, never committed.
- The timeout is set on the transaction, so the database enforces it. A timer on our side
  gives up half a second later, because the database checks on an interval.
- Rows are read one at a time and reading stops at the limit. Nothing is appended to the
  query, so a `LIMIT` of the caller's cannot raise the limit, and `truncated` is exact.
- Internal nodes (a label that starts with an underscore) come back as `null`, as does a path
  through one, and are counted in `withheld`.

**Which layer is trusted for what:**

| Concern                               | Carried by                                             |
| ------------------------------------- | ------------------------------------------------------ |
| Writes                                | The database (read-access transaction), check in front |
| Imports, and code installed on server | The check (the two allow-lists)                        |
| Time and result size                  | The executor                                           |
| Internal nodes in results             | The executor, with the check refusing their labels     |

## Alternatives Considered

- **Keep both checks and add the missing names to each**: rejected. A list of unwanted names
  over an open set is never complete, and two copies drift again.
- **Ask the database to classify the query** (`EXPLAIN`, then read the plan): rejected for
  now. The plan's format belongs to the server version, and it says nothing about functions.
  It could become a third layer later.
- **Server settings** (a procedure allow-list, import restrictions) **or a restricted database
  user**: not available on the managed deployment, and the Community edition has no roles.
  Worth adding for self-hosted installs, in addition to this and not instead of it.
- **A Cypher parser library**: rejected. It ties the check to one grammar version and adds a
  large dependency; the rules above need tokens, not a syntax tree.

## Consequences

- A procedure or a namespaced function that is not listed is refused, harmless ones included
  (APOC's text and collection helpers, for example). Adding one is a line in the list, under
  the rule written above it: it reads the graph and nothing else.
- A label or property named like a refused keyword must be quoted in backticks. The graph
  schema has none today.
- `graph_query` now has the timeout its docs promised, and its row limit cannot be raised.
- The two surfaces report failures by kind (`timeout`, `write_refused`, `failed`), not by
  matching the database's message.
- `graph_query` stays withheld from agents (`agents: false`). Offering it is the owner's call.

## Facts that cost time to establish

Observed on Neo4j 5.26 Community with `neo4j-driver` 6.1, on a throwaway instance:

- A write in a read-access transaction fails with `Neo.ClientError.Statement.AccessMode`.
- A transaction past its timeout fails with
  `Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration`, but only when the
  server next checks: a 400 ms timeout took about 1.5 s to fire.
- Leaving a `for await` over a driver result discards the rest of it; a rollback then returns
  at once, even for a query with millions of rows left.
- The server decodes `\u` escapes anywhere in the query before it reads it.

The api-server suite `cypher-query-service.integration.test.ts` pins the first three against
a real database (CI's `integration` job; locally, point `NEO4J_TEST_URI` at a scratch
instance, never at the dev graph: the suite wipes it).

## Revisit Triggers

- A new Neo4j major version or Cypher version: review the keyword list for new clauses.
- A new plugin on the database, or a need for a procedure or function that is not listed.
- A database edition or tier with per-role privileges: run these two surfaces as a database
  user that can only read the catalog, and keep this as the layer in front.
- A decision to offer `graph_query` to agents.
- A change in where the application keeps its own records (the underscore-labelled nodes).

## Related

- [harden-raw-cypher](../status/harden-raw-cypher.md) — the branch that made this change
- [no-tenant-read-isolation-authenticated-sees-all](no-tenant-read-isolation-authenticated-sees-all.md) — who may read the catalog
- [mcp-token-auth-stage-2a](mcp-token-auth-stage-2a.md) — where access tokens are stored
- [cypher-limit-skip-reject-js-number-floats](../scars/cypher-limit-skip-reject-js-number-floats.md) — the row limit here is applied by stopping the read, not by a `LIMIT` parameter
