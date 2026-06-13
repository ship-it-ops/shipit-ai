---
type: decision
status: active
created: 2026-06-12
updated: 2026-06-12
author: claude-session-2026-06-12
tags: [auth, allow-list, guardrail, gsm, deploy]
importance: core
---

# Login guardrail: GSM-backed email allow-list with admin bypass

## Context

portal-demo is publicly reachable with working GitHub sign-in; any GitHub
user with a verified email could authenticate (allowList defaulted empty =
allow everyone). The operator wants a small whitelist without a
commit+build+deploy cycle per edit. Settings-UI editing (option C) was
deferred; org-membership gating (`allowedOrgs`) exists separately.

## Decision

Mirror the `auth-admin-emails` pattern exactly:

- New read-only logical secret `auth-allow-list-emails` (GSM container
  `shipit-auth-allow-list-emails`) hydrating to `SHIPIT_AUTH_ALLOWLIST`
  at boot. NOT in `WRITABLE_SECRETS` — the app never writes it; a future
  settings-UI editor would move it there.
- `applyDerivedAuthConfig` fills an empty `auth.allowList` from the CSV
  (trim, drop empties). A config-provided list always wins; whitespace-only
  env is treated as unset. Empty/unset → everyone may sign in (unchanged).
- **Admin bypass** in the auth callback: `principal.role === 'admin'`
  (derived from `admins[]`, matched against any verified email) skips the
  allow-list check — operators can never lock themselves out.
- Matching uses ALL verified GitHub emails (see
  [login-loop-secure-cookie-trustproxy](../investigations/login-loop-secure-cookie-trustproxy.md)
  for the widening).

## Operator runbook

```sh
printf 'alice@example.com,bob@example.com' | \
  gcloud secrets versions add shipit-auth-allow-list-emails \
    --project=ship-it-ai-portal --data-file=-
kubectl rollout restart deployment/api-server -n shipit
```

Disable the guardrail by adding a version containing only whitespace/commas
(derivation no-ops) — no deploy needed in either direction.

## Infra dependency (cross-repo brief — landed 2026-06-12, with correction)

Terraform in shipit-ai-infra creates GSM container
`shipit-auth-allow-list-emails` with the api-server GSA granted
**secretAccessor only** (no addVersion). CORRECTION from the infra side:
our original brief said "add to `secret_ids` only", but the api-server
GSA's read access flows exclusively through `feature_secret_ids`
(accessor+versionAdder) — `secret_ids` alone grants the app NOTHING and
boot hydration would have crashed with the same PERMISSION_DENIED as the
run-6 setup-completed incident. Infra added a third grant tier,
`app_reader_secret_ids` (accessor-only for `writer_members`; their
decision D21), which carries this secret. Lesson for future briefs:
read-only-to-the-app secrets need that tier, not `secret_ids` membership.

**Ordering**: the infra apply must land before an app image containing
this change deploys — a missing CONTAINER (vs. an empty one) crashes
boot.

## Revisit Triggers

- Settings-UI access-control editor (option C): add to WRITABLE_SECRETS,
  follow the OidcSettingsService pattern, live-update without restart.
- Postgres config store lands → allowList moves there with the rest.
