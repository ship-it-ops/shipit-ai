---
type: status
status: completed
created: 2026-07-17
updated: 2026-08-13
author: claude-session-2026-07-17
branch: rework-secrets-plus-feedback
agent: claude-session-2026-07-17
tags: [secrets, config, gsm, refactor]
---

# Config-driven secrets registry rework (+ feedback launcher fix)

## Scope

Branch `rework-secrets-plus-feedback`, 13 commits ahead of main (pushed, no PR yet).
Executes `docs/superpowers/plans/2026-07-01-config-driven-secrets-registry.md` per the
approved design `docs/superpowers/specs/2026-07-01-config-driven-secrets-registry-design.md`.
Also carries c64aa66 (feedback launcher shows when configured; error on submit if token
missing) — the fix that motivated the rework.

## Current state (verified 2026-07-18)

- All 12 plan tasks implemented. Tasks 1–9 committed earlier; Tasks 10–12 implemented
  2026-07-18 (uncommitted, pending user commit approval): neo4j + webhook-secret via
  accessor, auth bootability/derivation/setup-wizard via accessor, boot-hydration
  integration test, and full `signingSecretEnv`/`clientSecretEnv` straggler removal
  (schema fields deleted, YAML + all tests swept).
- Verification: `turbo typecheck` and `turbo test` green across all 14 workspace tasks
  (api-server 557, shared 136, web-ui 171); plan's straggler grep returns empty.
- Documented deviations from the plan (all behavior-preserving):
  1. `neo4j.password` stays in YAML/schema as the carrier for core-writer (boots with
     plain `loadConfig()`, no hydration) and local-dev `shipit.config.local.yaml`
     literals; api-server reads accessor-first with config fallback.
  2. `connectors.github.app.id` stays `${GITHUB_APP_ID:-}` — the live-reference
     hot-reload pattern (PUT /github/app) owns runtime id changes; only the dead
     `webhookSecret: ${GITHUB_WEBHOOK_SECRET:-}` config value was removed.
  3. LIVE_ENV_KEYS grew: github-webhook-secret (admin rotation), oauth client pair +
     oidc-client-secret (setup-wizard mid-session writes) — runtime-mutable secrets
     must be live env views, not boot snapshots.
  4. New `envSecretsView()` fallback accessor for surfaces built without hydration
     (tests, setup mode) — pure env view, behavior-identical.

## Why

Feedback-widget token was invisible because secrets reached the app via three inconsistent
mechanisms; see the design doc's Problem section and
[feedback-widget-service-identity](../decisions/feedback-widget-service-identity.md).

## Done when

PR #96 merged (check: `gh pr view 96 --json state -q .state` prints `MERGED`).
