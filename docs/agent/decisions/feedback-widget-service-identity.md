---
type: decision
status: active
created: 2026-06-25
updated: 2026-06-25
author: claude-session-2026-06-25-feedback-widget
tags: [feedback, github, issues, auth, web-ui, api-server, secrets]
importance: standard
---

# In-app feedback widget files issues via a server-held service PAT, not the user's token

## Context

We added a "Report a problem" widget (floating FAB on every authenticated page) that
opens a form, auto-captures environment + recent console logs, and files a GitHub issue
in the product repo. The open question was **which GitHub identity files the issue**.
Reusing the logged-in user's GitHub identity was explicitly considered (and asked for).

## Decision

Issues are filed by a **server-held fine-grained PAT** (`FEEDBACK_GITHUB_TOKEN`,
`issues:write`) via the existing `authenticatePAT()` in
`packages/connectors/github/src/auth.ts`. The reporter is attributed in the issue body
from their session (`request.ctx.user`), never from a GitHub token.

- Backend: `FeedbackService` (`services/feedback-service.ts`) + `routes/feedback.ts`
  (`POST /api/feedback`, `GET /api/feedback/config`), wired in `index.ts`/`server.ts`.
  Any signed-in user may submit (global require-auth); per-user Redis cooldown
  (`feedback-rl-<userId>`, 60s) blunts spam; browser console logs are redacted for
  obvious secrets before embedding (public-repo safety).
- Config: top-level `feedback` block (`enabled`, `repo.{owner,name}`, `defaultLabels`)
  in `shared/src/config/schema.ts`. `enabled` is a literal (the loader yields strings
  for `${...}`, so an env-driven boolean would fail Zod); the real gate is runtime —
  repo configured AND token present. Token is a read-only `LogicalSecret`
  `github-feedback-token` (hydrated from GSM at boot; NOT in `WRITABLE_SECRETS`).
- v1 ships **logs + metadata only** — no screenshot upload (see plan).

## Alternatives Considered

- **Reuse the logged-in user's GitHub token** — rejected (verified in code, not assumed):
  the login OAuth token is discarded after the profile read
  (`services/auth/github-provider.ts:126-138`); it carries only `user:email`/`read:org`,
  never `repo`/`public_repo`; OIDC + dev-fallback users have no GitHub token at all; and
  portal users are customers syncing their own orgs, not collaborators on the product
  repo. Any one of these is fatal.
- **Dedicated GitHub App** (issues:write installation) — viable and more rotatable, but
  heavier (create + install an App, persist a PEM). PAT chosen for v1 simplicity; can
  migrate later behind the same `octokitForToken` seam.
- **Multipart upload for screenshots** — deferred; GitHub REST can't upload images and
  there's no blob store. Phase 2 path: commit to a `feedback-assets` branch via the
  contents API (needs `contents:write`) or a GCS bucket.

## Consequences

- Works regardless of how the user authenticated (GitHub/OIDC/dev).
- A new prod secret (`shipit-github-feedback-token`) needs a Terraform-provisioned GSM
  container in the infra repo (containers are infra-owned; the app only adds versions).
- The PAT is a single shared credential — rotation is manual (GSM version + restart).

## Revisit Triggers

- Need per-user attribution as the GitHub author (not just body text) → dedicated App +
  installation token, or GitHub's issue-import on behalf.
- Screenshot attachment is prioritized → Phase 2 (contents API or GCS).
- Spam/abuse from authenticated users → tighten the rate limit or gate to admins.

## Related

- [feedback-widget-v1](../plans/ds-upstream-feedback-widget.md) — DS asks for a clean widget
- [auth-oauth-app-separate-from-connector](./auth-oauth-app-separate-from-connector.md) — why login has no repo-scoped token
- [gsm-secret-store-and-config-export](./gsm-secret-store-and-config-export.md) — how the token reaches the pod
- [saas-tier-shared-github-app](../plans/saas-tier-shared-github-app.md) — portal users are customers, not repo collaborators
