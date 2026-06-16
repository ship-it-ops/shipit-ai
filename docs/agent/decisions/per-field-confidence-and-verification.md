---
type: decision
status: active
created: 2026-06-15
updated: 2026-06-15
author: claude-session-2026-06-15-confidence
tags: [confidence, claims, verification, reconciliation, corroboration]
importance: core
---

# Per-Field Confidence + Verification (Hybrid Heuristic Model)

## Context

Connector claims carried a hardcoded confidence (GitHub 0.9, codeowner edges 0.95,
login 0.85) and field resolution only max-picked/ranked competing claims — confidence
was never combined, so every field read ~90% regardless of corroboration. User wants
per-field confidence where (1) independent corroboration raises it, (2) ambiguity /
multiplicity (e.g. many codeowners) lowers it, and (3) a human can verify a field so
it is treated as assured.

## Decision

Build a **hybrid**: a single shared **heuristic-additive** numeric engine
(`computeFieldConfidence`) + a **derived verification status** layer on top, reusing
the existing Claim Explorer and Reconciliation surfaces.

Formula (constants in `CoreWriterConfig.confidenceTuning`):
`effective = clamp(base − decay + corrob_bonus − conflict_pen − ambiguity_pen, 0, 1)`,
then `if verified && verified_value===winner.value: effective = max(effective, 0.98)`.

- Corroboration counts **independence-GROUPS** (registry: scm/apm/runtime/catalog/human
  - `derivesFrom`), NOT raw sources — Datadog re-imports repo metadata from GitHub, so
    counting it as a second witness would manufacture false confidence.
- Ambiguity: distinguish "N sources agree on 1 value" (raises) from "1 source asserts
  N values for a single-valued field" (lowers). Ownership uses node-level
  `ownership_clarity`; individual codeowner edges stay 0.95.
- One pure function shared by write (snapshot) AND read (display) paths.
- Verification = a `verified:<user>` PropertyClaim in the existing `_claims` array
  (no schema break, survives re-sync via existing (source,source_id,property_key) dedup).
  Pins value + floors confidence to 0.98. Contradicting re-sync → `needs_review`, value
  stays verified, surfaced as a reconciliation-style candidate with a `VerificationEvent`
  audit node mirroring `MergeEvent`.

## Alternatives Considered

- **Pure Bayesian noisy-OR** (`1−Π(1−cᵢ)`): mathematically correct but needs calibrated
  per-source priors we don't have; unexplainable numbers. Deferred — becomes viable once
  user-verifications accumulate as labeled data; swappable behind `computeFieldConfidence`.
- **Pure verification state-machine** (status drives fixed bands): loses the smooth
  corroboration/ambiguity gradient the requirements ask for. Adopted as the _layer on
  top_, not the engine.
- All three debate agents independently converged on this same hybrid.

## Consequences

- Fixes two pre-existing bugs as a side effect: read path ignored decay; `manual` source
  matched/ranked differently in writer vs API (see
  [manual-edit-write-path](../open-questions/manual-edit-write-path.md)).
- Adds the first claim WRITE path (verify endpoint) — previously seed-only.
- Per-field confidence + status + explainable breakdown shown in Claim Explorer.

## Revisit Triggers

- Enough verifications exist to fit per-source reliabilities → swap engine to Bayesian.
- Need per-`property_key` independence (Datadog independent for runtime, derived for name).

## Related

- [mcp-tool-metadata-as-pure-data-module](./mcp-tool-metadata-as-pure-data-module.md)
- [canonical-id-org-namespacing](./canonical-id-org-namespacing.md)
- [manual-edit-write-path](../open-questions/manual-edit-write-path.md)
- Plan: `~/.claude/plans/i-want-a-per-field-hidden-russell.md`
