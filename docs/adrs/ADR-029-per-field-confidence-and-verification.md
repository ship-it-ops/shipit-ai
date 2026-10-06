# ADR-029: Per-Field Confidence and Human Verification

## Status

Accepted

## Date

2026-06-15

## Context

Connector claims carried hard-coded confidences (GitHub 0.9, CODEOWNERS edges 0.95) and resolution only ranked competing claims; nothing combined them, so every field read about 90% whatever corroborated it. The product wants independent corroboration to raise a field's confidence, ambiguity to lower it, and a person to be able to verify a field so it is treated as assured.

## Decision

A hybrid: one shared heuristic engine, `computeFieldConfidence`, used by both the write path (snapshot) and the read path (display), with a derived verification status on top.

- `effective = clamp(base − decay + corroboration − conflict − ambiguity, 0, 1)`; constants live in `CoreWriterConfig.confidenceTuning`.
- Corroboration counts **independence groups** (scm, apm, runtime, catalog, human; a source registry records what derives from what), not raw sources: a monitoring tool that re-imports repository metadata from GitHub is not a second witness.
- Ambiguity distinguishes several sources agreeing on one value (raises) from one source asserting several values for a single-valued field (lowers).
- Verification is a `verified:<user>` claim in the node's existing `_claims` array: no schema change, survives re-sync, pins the value and floors confidence at 0.98. A later contradicting sync sets `needs_review` and surfaces as a reconciliation-style candidate with a `VerificationEvent` audit node.

## Consequences

### Positive

- Confidence is explainable: the Claim Explorer shows the breakdown.
- Fixed two latent bugs on the way (decay ignored on read; manual claims ranked differently in the writer and the API).

### Negative

- Heuristic constants, not calibrated probabilities.

### Neutral

- The engine is swappable behind one function once enough verifications exist to fit per-source reliabilities.

## Alternatives Considered

### Bayesian noisy-OR

- **Cons:** Needs calibrated priors the project does not have; the numbers are not explainable to a user.

### A pure verification state machine

- **Cons:** Loses the corroboration and ambiguity gradient; adopted as the layer on top instead.

## References

- `docs/agent/decisions/per-field-confidence-and-verification.md`
- `packages/shared/src/confidence/`, `packages/api-server/src/services/verification-service.ts`
