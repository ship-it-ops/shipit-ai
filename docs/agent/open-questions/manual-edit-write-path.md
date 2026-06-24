---
type: open-question
status: active
created: 2026-06-04
updated: 2026-06-23
author: claude-session-2026-06-04-deployment
opened: 2026-06-04
answer-source: maintainer
tags: [claims, provenance, manual-edits, webapp, rbac, bug]
---

# Manual webapp edits: write path not built, and a `manual` source-priority inconsistency

## Context

The data model fully supports **manual edits coexisting with synced data** —
this is by design, not accidental:

- Every node stores `_claims[]` tagged by `source` (`github`, `kubernetes`,
  `manual:<user>`, …). A GitHub re-sync replaces only same-`source` claims
  (`ClaimResolver.mergeClaims`, `packages/core-writer/src/claims/resolver.ts`),
  so `manual:*` claims **survive every re-sync**. The displayed value is chosen
  per-property by a resolution strategy (`MANUAL_OVERRIDE_FIRST` always lets the
  manual claim win).
- Edges are written with a plain idempotent `MERGE` and **no pruning**
  (`mergeEdge`, `packages/core-writer/src/neo4j/queries.ts`), so a
  manually-added relation GitHub doesn't know about persists indefinitely. The
  only deletes in the system are reversible **soft-deletes** during identity
  reconciliation — not routine sync pruning.

So the survival guarantee is solid. Two gaps remain.

### Gap 1 — the write endpoints don't exist yet

`packages/api-server/src/routes/claims.ts` is **read-only**; its header says
_"Phase 3 RBAC will gate write-only override paths."_ There is no
`POST /claims` override route and no add-relation/edge mutation route. Manual
claims currently appear only via the seed script. **The capability is designed-in
and the writer honors it, but the webapp/API to create manual edits is still
TODO.**

### Gap 2 — `manual` source-priority is inconsistent across the two code paths

For the `AUTHORITATIVE_ORDER` strategy the two files disagree on whether `manual`
wins:

- writer effective-value path (`packages/core-writer/src/claims/strategies.ts`)
  `SOURCE_PRIORITY` puts **`manual` first** (highest).
- API read/display path (`packages/api-server/src/services/claim-service.ts`)
  `DEFAULT_SOURCE_ORDER` puts **`manual` last** (lowest).

These must be reconciled before relying on manual overrides under
`AUTHORITATIVE_ORDER`, or the written winner won't match the displayed winner.

## Update 2026-06-23 (audit) — Gap 2 RESOLVED, Gap 1 still partial

- **Gap 2 — FIXED/SHIPPED (PR #74, `9d19e65`).** The two diverging lists were
  replaced by a single shared registry: `SOURCE_PRIORITY_ORDER` in
  `packages/shared/src/config/source-reliability.ts` (`manual` ranks 2nd, just
  below `verified`). Both the writer (`core-writer/.../claims/strategies.ts`
  `sourceRank`) and the API read path (`api-server/.../claim-service.ts`
  `sourceRank`) now consume it — written winner == displayed winner. The fix
  comment cites this doc.
- **Gap 1 — still partially open.** A _verification_ write path now exists
  (`POST /api/claims/:entityId/:propertyKey/verify` + `POST /api/claims/review/resolve`,
  writing `verified:<actor>` claims). Still NOT built: the `manual:<user>`
  override claim route, the add-relation/edge mutation endpoint, and the
  Phase-3 RBAC gating on claim-write routes (claims.ts header still says RBAC
  pending; writes are only rate-limited, not role-gated).

Remaining work for this question = Gap 1's three items only.

## Tried

Traced the full write path (resolver → mergeClaims → mergeNode/mergeEdge) and
grepped routes for manual/override/relation mutation endpoints — only read routes
exist.

## Decision / work needed

1. Build the manual write path (POST claim override + add-relation), gated by the
   Phase-3 RBAC mentioned in the route header.
2. Pick a single canonical source-priority order and share it between
   `strategies.ts` and `claim-service.ts` (ideally one constant in `shared`).

Independent of the `embedded`/`distributed` hosting toggle — provenance lives in
Neo4j, so the deployment-mode work does not affect it.

## Who Can Answer

Maintainer (user) — confirm the canonical source order and when the manual write
path / RBAC gating is scheduled.

## Related

- [deployment-runtime-modes](../plans/deployment-runtime-modes.md) — manual-overlay survival is orthogonal to the hosting toggle
- [canonical-id-org-namespacing](../decisions/canonical-id-org-namespacing.md) — related identity/claims work
