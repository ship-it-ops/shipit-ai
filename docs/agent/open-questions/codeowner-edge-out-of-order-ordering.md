---
type: open-question
status: active
opened: 2026-06-19
answer-source: maintainer
tags: [core-writer, edges, codeowners, ordering, webhooks]
---

# Should CODEOWNER (and other) edges get out-of-order overwrite protection?

## Context

Cut B adds a freshness guard for NODES only. The Cut B audit (finding adversarial-1) noted that
`normalizeCodeowner` returns `nodes: []` and only `CODEOWNER_OF` edges, so it has no node to carry an
`_event_version` and never reaches the node guard. `mergeEdge` (core-writer `queries.ts`) is an
unconditional `SET r += ...` with no version/ordering — so out-of-order CODEOWNER edge deliveries are
last-writer-wins, unaddressed by Cut B. The same applies to other edge types (MEMBER_OF, BUILT_BY,
DEPENDS_ON, etc.).

## Tried

Scoped OUT of Cut B deliberately (Cut B is node-versioning). Edge dedup today is a content-sha jobId at the
BullMQ layer (event-bus `buildEdgeBatchIdempotencyKey`), which dedups identical edge batches but does not
order conflicting ones.

## Who can answer

Maintainer — needs a decision on whether edge ordering is a real risk for this data model (edges are
mostly idempotent relations; ordering may not matter) before investing in edge-level versioning.
