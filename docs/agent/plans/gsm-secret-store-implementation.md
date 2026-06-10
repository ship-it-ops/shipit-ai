---
type: plan
status: completed
created: 2026-06-09
updated: 2026-06-10
author: claude-session-2026-06-09
tags: [secrets, gsm, onboarding, kubernetes, cross-repo]
importance: core
---

# GSM secret store + config export — implementation plan (pointer)

## Goal

Onboarding-created credentials persist to GSM via Workload Identity and
re-hydrate on boot; `GET /api/config/export` lets the operator carry runtime
config into the next deploy's seed. One PR.

## Approach

The full task-by-task plan (12 TDD tasks, complete code) lives at
**`docs/superpowers/plans/2026-06-09-gsm-secret-store.md`**; the approved spec
at `docs/superpowers/specs/2026-06-09-gsm-secret-store-design.md`. Summary:
secrets module (types → FileStore → GsmStore → factory → hydration) → boot
wiring → manifest-exchange GSM writes → OIDC settings endpoint → config-export
endpoint → web-UI Instance tab → full verification.

## Status

Implemented 2026-06-10 on branch `setup-infra` (12 tasks, all reviewed; commits
`c5786cc..` through the web-UI Instance tab + docs follow-ups). Review findings
folded in along the way: instance-target GSM gating, `backend.mcp.apiKeySecret`
export scrub, seed-config `GITHUB_OAUTH_CLIENT_SECRET` env-name fix. Remaining:
PR + infra repo's matching IAM/WI/chart changes — the Q1–Q5 contract answers
are in the spec's "Cross-repo follow-ups for infra" section and must ride in
the PR description.

## Related

- [gsm-secret-store-and-config-export](../decisions/gsm-secret-store-and-config-export.md) — the decision behind this plan
