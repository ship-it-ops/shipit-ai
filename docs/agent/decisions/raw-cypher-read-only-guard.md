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
  that runs into a name, a `$` that runs on from a name, more than one statement. A leading
  `CYPHER` block is refused for the same reason: it picks the language version, and with it
  the tokens.
- A name that starts with an underscore is taken for an internal label and refused wherever
  it stands, except as a property or a map key. A label chosen when the query runs (`$(...)`)
  is refused.

**One executor**, `runReadOnlyQuery` in `@shipit-ai/mcp-server`
(`packages/mcp-server/src/cypher/read-only-query.ts`, exported as
`@shipit-ai/mcp-server/cypher`), used by both surfaces.

- The transaction is opened for read access and is always rolled back, never committed.
- The timeout is set on the transaction, so the database enforces it. A timer on our side
  gives up half a second later, because the database checks on an interval.
- Rows are read one at a time and reading stops at the limit. Nothing is appended to the
  query, so a `LIMIT` of the caller's cannot raise the limit, and `truncated` is exact.
- An internal node (a label that starts with an underscore) comes back as `null`, as does a
  path through one, and is counted in `withheld`.
- A driver carries at most four of these queries at a time and refuses the next (`busy`). A
  place is held until the session has closed, not until the caller has been answered.
- A result holds at most 100,000 values, counting every row, list item and map entry
  (`too_large`): the row limit counts rows, and one row can carry a list of any length. The
  driver has to receive a whole row before this sees it, so the bound is on what goes on from
  there.

**Who may run one.** Administrators, and bearer tokens an administrator minted with the
`graph:query` scope (`GRAPH_QUERY_CAPABILITY` in `@shipit-ai/shared`): a raw query reads
everything in the graph, the application's own records included. `POST /api/query` checks the
role or the capability; the web UI hides the Query Playground from members. Over HTTP the MCP
entry point hands each tool call its token's owner and scopes, and `graph_query` refuses a
token without the scope (`RBAC_DENIED`) and counts the owner's calls against
`graphQueryPerDay` (`RATE_LIMIT_EXCEEDED`), in the process's memory. Over stdio there is no
token: that is the operator's own trust.

**The network surface answers every request again.** The stateless entry point reused one
transport and one server for all requests; `@modelcontextprotocol/sdk` 1.29 refuses to serve a
second request through the same stateless transport, and the Node adapter turned that into an
empty 500 with nothing logged, so on `main` the MCP server over HTTP answered only the first
request of its life. Found while checking the scope end to end. Now a server and a transport
are made per request (`createHttpRequestListener`), the daily budget is the process's, and
`packages/mcp-server/src/__tests__/http.test.ts` sends three requests through a real HTTP server.

**graph_query's hop limit** reads the query's code (`cypherCodeText`, the text with strings,
comments and quoted names blanked) and requires every variable-length pattern and quantified
path pattern to carry an upper bound of at most `hopLimit`: `[*]`, `[*2..]`, `{3,}`, `-->+` and
`(...)*` are refused, `shortestPath((a)-[*]-(b))` among them (it needs `[*..6]`). A `+` or `*`
after a closing parenthesis counts as a quantifier only when the parentheses hold a
relationship, so `(a) * (b)` stays arithmetic. The daily budget counts queries that run, not
ones the checks refused.

**Which layer is trusted for what:**

| Concern                                   | Carried by                                                          |
| ----------------------------------------- | ------------------------------------------------------------------- |
| Who may run one                           | The route (role or capability); the tool (the token's scope)        |
| Writes                                    | The database (read-access transaction), check in front              |
| Imports, and code installed on the server | The check (the two allow-lists)                                     |
| Time                                      | The transaction's timeout between rows; the limit of four otherwise |
| Rows, and values in all                   | The executor                                                        |
| Depth of a pattern                        | The tool's hop limit, on the query's code                           |
| Internal nodes returned as nodes or paths | The executor, with the check refusing their labels                  |

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
  the rule written above it: it reads the graph and nothing else. `apoc.convert.toJson` is
  deliberately not listed: reading claims needs the two functions that parse JSON, not the
  one that writes it.
- A variable or an alias that starts with an underscore is refused along with the labels.
- A label or property named like a refused keyword must be quoted in backticks. The graph
  schema has none today.
- `graph_query` now has the timeout its docs promised, and its row limit cannot be raised.
- The two surfaces report failures by kind (`busy`, `timeout`, `write_refused`, `failed`), not
  by matching the database's message. `busy` is `429 QUERY_BUSY` on the route and a new MCP
  error code, `SERVER_BUSY`, on the tool.
- Members no longer see or reach the Query Playground; a member who needs raw Cypher needs an
  administrator's token with the scope, or the role. Granting the capability by role is one
  line in `capabilitiesForRole` (api-server `routes/auth.ts`).
- A result of more than 100,000 values is refused (`400 RESULT_TOO_LARGE`, `ROW_LIMIT_EXCEEDED`).
- The daily count lives in each process and starts again with it.
- `graph_query` stays withheld from agents (`agents: false`). Offering it is the owner's call.

## Facts that cost time to establish

Observed on Neo4j 5.26 Community with `neo4j-driver` 6.1, on a throwaway instance:

- A write in a read-access transaction fails with `Neo.ClientError.Statement.AccessMode`.
- A transaction past its timeout fails with
  `Neo.ClientError.Transaction.TransactionTimedOutClientConfiguration`, but only when the
  server next checks: a 400 ms timeout took about 1.5 s to fire.
- Leaving a `for await` over a driver result discards the rest of it; a rollback then returns
  at once, even for a query with millions of rows left.
- The database ends a query that is past its timeout between rows, not inside one. Work that
  sits in a single row (one large expression) runs to its end, and the session's close
  settles only then. That is what the limit of four is for.
- The server decodes `\u` escapes anywhere in the query before it reads it.
- To the server `$` is a name character after the first (`a$b` is one name), and a number may
  carry `_` separators. The check refuses both spellings.

An independent review compared the check's tokens with the server's own Cypher 5 lexer on
random texts; the one disagreement it found (the `$` above) is now refused. It also showed
that six rules could be broken with every test passing; the tests it proposed are in, and
each of those six mutations now fails the suite.

The api-server suite `cypher-query-service.integration.test.ts` pins the first four against a
real database (CI's `integration` job; locally, point `NEO4J_TEST_URI` at a scratch instance,
never at the dev graph: the suite wipes it).

## Revisit Triggers

- A new Neo4j major version, or a database whose default language is not Cypher 5: review the
  keyword list for new clauses, and the tokenizer against that version's lexer.
- A new plugin on the database, or a need for a procedure or function that is not listed.
- A database edition or tier with per-role privileges: run these two surfaces as a database
  user that can only read the catalog, and keep this as the layer in front.
- A decision to offer `graph_query` to agents.
- A decision to let members run raw Cypher again (grant `graph:query` by role).
- A change in where the application keeps its own records (the underscore-labelled nodes).

## Related

- [harden-raw-cypher](../status/harden-raw-cypher.md) — the branch that made this change
- [no-tenant-read-isolation-authenticated-sees-all](no-tenant-read-isolation-authenticated-sees-all.md) — who may read the catalog
- [mcp-token-auth-stage-2a](mcp-token-auth-stage-2a.md) — where access tokens are stored
- [cypher-limit-skip-reject-js-number-floats](../scars/cypher-limit-skip-reject-js-number-floats.md) — the row limit here is applied by stopping the read, not by a `LIMIT` parameter
