---
type: scar
status: active
created: 2026-06-24
updated: 2026-06-24
incident-date: 2026-06-24
author: claude-session-2026-06-24-audit-retention
tripwire: "a Cypher LIMIT/SKIP $param fed a plain JS number throws 22N03 'Expected value to be of type INTEGER ... but found N.0' — the driver marshals JS numbers as FLOAT; wrap with neo4j.int()"
tags: [neo4j, cypher, neo4j-driver, integer, limit, marshalling]
---

# Cypher LIMIT/SKIP rejects JS-number params (they marshal as FLOAT, not INTEGER)

## What Happened

The audit-retention cleanup issued `... WITH e LIMIT $batch DETACH DELETE e` with
`{ batch: 1000 }` (a plain JS number). It passed every unit test (fake Neo4j) but
the real-Neo4j integration test failed immediately with
`Neo.ClientError ... 22N03: Expected 'value' to be of type INTEGER and in the
range 0 to 9223372036854775807 but found 10.0`. The neo4j-driver marshals a plain
JS `number` to a Cypher FLOAT (`10.0`); `LIMIT`/`SKIP` accept only INTEGER.

## Tripwire

A Cypher query with `LIMIT $param` / `SKIP $param` (or any integer-typed slot)
that works against a fake but throws `22N03 ... found N.0` against a real DB →
the param is a JS number marshalled as FLOAT. Wrap it: `neo4j.int(n)`.

## Why It Hurt

Invisible to the unit suite — fakes don't enforce Neo4j's type system — so it
reads as green until a real DB rejects it at runtime. A batched/paginated delete
or query that only ever ran in tests would fail the first time it touched a real
Neo4j in production.

## Don't Do This

- Don't pass a plain JS `number` into a Cypher `LIMIT`/`SKIP` (or any
  INTEGER-typed parameter). Use `neo4j.int(n)` from `neo4j-driver`.
- Don't trust a fake-Neo4j unit test alone for anything touching Cypher's type
  system — pair it with a real-DB integration test (the one here caught this).

## Related

- [manual-edit-write-path](../plans/manual-edit-write-path.md) — the audit-retention follow-up where this surfaced
- [integration-tests-sharing-a-db-must-run-serially](integration-tests-sharing-a-db-must-run-serially.md)
