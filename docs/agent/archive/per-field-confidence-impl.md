---
type: status
status: completed
created: 2026-06-15
updated: 2026-06-15
author: claude-session-2026-06-15-confidence
branch: main
agent: claude-session-2026-06-15-confidence
tags: [confidence, claims, verification, reconciliation]
---

# Per-field confidence + verification — implemented, NOT committed

> **SHIPPED & DEPLOYED** (#74, 2026-06). Archived. Deferred follow-ups
> (write-time confidence snapshot, Bayesian engine, per-property independence,
> RBAC on write endpoints) remain tracked in the decision + plan.

Implements [per-field-confidence-and-verification](../decisions/per-field-confidence-and-verification.md).

## Scope (landed, uncommitted)

- **shared**: new `config/source-reliability.ts` (base trust + independence groups +
  `SOURCE_PRIORITY_ORDER`); `utils/confidence.ts` gains `computeFieldConfidence`
  (heuristic engine), `deriveVerificationStatus`, `decayLoss`/`weeksSince`,
  `ConfidenceTuning`/`DEFAULT_CONFIDENCE_TUNING`; `PropertyClaim` +verified_by/at/value;
  `claims-api.ts` +`ConfidenceBreakdown`/`VerificationStatus`, extended `ResolvedProperty`
  (confidence/breakdown/status/needs_review). +17 engine tests.
- **core-writer**: `strategies.ts` consumes shared `sourceRank`; MANUAL_OVERRIDE honors
  `verified:`>`manual:`; `config.ts` +`confidenceTuning`.
- **api-server**: `claim-service.ts` read path computes breakdown/status/needs_review and
  now applies DECAY on read + shared priority (fixes both bugs in
  [manual-edit-write-path](../open-questions/manual-edit-write-path.md)). New
  `verification-service.ts` (verify / listReviewQueue / resolveReview + VerificationEvent
  audit node). `routes/claims.ts` +POST `/:entityId/:propertyKey/verify`, GET
  `/review-queue`, POST `/review/resolve`. +8 service tests.
- **web-ui**: `lib/api.ts` +types & `verifyClaim`/`fetchReviewQueue`/`resolveReview`;
  `claim-list.tsx` renders status badge, effective %, explainable breakdown sentence,
  needs-review badge, and a per-property Verify button (invalidates `['claims', id]`).

## Verified

Full workspace green: `pnpm -r typecheck` EXIT 0; `pnpm -r test` EXIT 0 (api-server 298,
shared 90, core-writer 67, web-ui 88, github 30, mcp 73, sdk 30, event-bus 20).
web-ui lint 0 errors.

## Follow-ups landed (2026-06-16, second pass)

- **Ownership-clarity wired live**: `claim-service.getClaimsForEntity` now counts
  CODEOWNER_OF edges and appends a derived `ownership_clarity` row whose confidence
  drops via the engine's ambiguity penalty (1 owner → 0.95, 5 → 0.65). Completes the
  3rd original requirement end-to-end.
- **Re-reviews tab**: added to the existing Reconciliation page (`pending | reviews |
merges`) listing `/review-queue` with Keep-verified / Accept-new actions via
  `resolveReview`. Verification conflicts are now actionable in the UI.

## Still deferred (documented in plan + decision)

- Write-time `<prop>_confidence` snapshot in core-writer (advisory; read path recomputes).
- Bayesian engine swap; per-property independence; RBAC on write endpoints.

## Blocked on

User approval to commit (standing memory: never commit/push without explicit approval).
