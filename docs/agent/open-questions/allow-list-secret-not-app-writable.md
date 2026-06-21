---
type: open-question
status: answered
created: 2026-06-18
updated: 2026-06-18
author: claude-session-2026-06-18-portal-settings
opened: 2026-06-18
answer-source: maintainer
tags: [infra, gsm, iam, allow-list, secrets, portal-settings]
importance: standard
---

# Login allow-list secret is not app-writable — needs an infra IAM grant

> **ANSWERED (2026-06-18).** Infra IAM grant (addVersion on
> `shipit-auth-allow-list-emails`) has been made (confirmed by maintainer).
> App-side shipped: `auth-allow-list-emails` added to `WRITABLE_SECRETS` and
> `PUT /api/settings/allowlist` enabled (Admin Portal Settings,
> [admin-portal-settings](../plans/admin-portal-settings.md)). NOTE: no
> self-lockout guardrail on the allow-list — admins bypass it (routes/auth.ts);
> the UI confirms before saving an empty list (which allows everyone).

## Context

The Admin Portal Settings plan ([admin-portal-settings](../plans/admin-portal-settings.md))
includes an editable login allow-list. But `auth-allow-list-emails` (GSM container
`shipit-auth-allow-list-emails`) is deliberately **NOT** in `WRITABLE_SECRETS`
(`packages/api-server/src/secrets/types.ts`) — it's operator-managed via gcloud; the
api-server SA can read it (hydrated to `SHIPIT_AUTH_ALLOWLIST`) but has no
`addVersion` grant. The code comment anticipates this: "a future settings-UI editor
would move it there."

The allow-list section therefore ships **read-only** with a "pending infra grant"
banner; the rest of the Portal Settings tab ships independently.

## What we need

Infra (Ship-It-Ops/shipit-ai-infra, `terraform/modules/secret-manager`) to grant the
api-server service account `roles/secretmanager.secretVersionAdder` on **only**
`shipit-auth-allow-list-emails` — mirroring the existing grants for
`shipit-auth-admin-emails`, `shipit-connector-apps`, `shipit-github-webhook-secret`.
Read access already exists; no new container.

## Infra brief (shared with user 2026-06-18)

> Grant the api-server SA `secretVersionAdder` on `shipit-auth-allow-list-emails`
> (ensure the container exists; read access already in place; mirrors the existing
> writable-secret pattern). No bootstrap-secret change.

## Once granted

App-side: add `auth-allow-list-emails` to `WRITABLE_SECRETS` and enable
`PUT /api/settings/allowlist`.

## Who can answer

Maintainer (Mohamed) — owns the infra repo / the Terraform IAM change.

## Related

- [admin-portal-settings](../plans/admin-portal-settings.md)
- [gsm-backed-login-allowlist](../decisions/gsm-backed-login-allowlist.md)
