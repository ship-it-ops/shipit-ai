---
type: status
status: active
created: 2026-06-15
updated: 2026-06-15
author: claude-session-2026-06-15-confidence
branch: main
agent: claude-session-2026-06-15-confidence
tags: [confidence, claims, verification, reconciliation]
---

# Per-field confidence + verification — implemented, NOT committed

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

## Deferred (documented in plan + decision)

- Ownership-clarity ambiguity wiring from CODEOWNER_OF edge count (engine + test exist;
  read-path edge-count wiring not done). Relates to active investigation
  [team-ownership-invisible-owns-and-blast-radius](../investigations/team-ownership-invisible-owns-and-blast-radius.md).
- Write-time `<prop>_confidence` snapshot in core-writer (advisory; read path recomputes).
- Reconciliation-tab UI surface for the re-review queue (API + queue done; dedicated UI
  reuse of compare-drawer not yet wired — Verify lives in Claim Explorer).
- Bayesian engine swap; per-property independence; RBAC on write endpoints.

## Blocked on

User approval to commit (standing memory: never commit/push without explicit approval).
