---
type: scar
status: active
created: 2026-06-19
updated: 2026-06-19
incident-date: 2026-06-19
author: claude-session-2026-06-19-cutb-exec
tripwire: "integration tests that pass when run alone but FAIL when run together (against the same real Neo4j/Redis) → vitest is running the files in PARALLEL and they're clobbering each other's data; run with --no-file-parallelism or isolate per-DB"
tags: [testing, integration-tests, vitest, neo4j, redis, isolation]
---

# Real-dependency integration tests sharing one DB must run serially (vitest parallelizes files)

## What Happened

The two core-writer Neo4j integration suites (`freshness-guard.integration.test.ts`,
`migrations.integration.test.ts`) each passed when run alone, but together (2 failed / 11
passed) the first time. Cause: vitest runs test FILES in parallel worker threads by default,
both connected to the same Neo4j, and the migrations suite's `afterEach` does
`MATCH (n) DETACH DELETE n` — which wiped the freshness-guard suite's in-flight nodes
mid-test (and the freshness-guard nodes polluted the migrations suite's graph-wide assertions).

## Tripwire

A real-dependency integration test green in isolation but red when the suite runs together →
it's parallel file execution sharing one database, not a logic bug.

## Why It Hurt

The failure is order/timing-dependent and invisible when you debug the one failing file alone
(it passes), so it reads as flakiness. Every wave of the integration-test roadmap (Redis+BullMQ,
more Neo4j) shares a real backend and will hit this.

## Don't Do This

- Don't let real-DB integration files run in parallel against a shared instance. Run the
  integration script with `--no-file-parallelism` (what `core-writer test:integration` now does),
  OR give each file its own database/keyspace/namespace.
- A graph-wide `MATCH (n) DETACH DELETE n` reset is only safe on a DEDICATED scratch DB AND
  under serial execution — never against a shared or real database.

## Related

- [integration-test-coverage-roadmap](../plans/integration-test-coverage-roadmap.md)
- [cutb-content-freshness-impl](../status/cutb-content-freshness-impl.md)
