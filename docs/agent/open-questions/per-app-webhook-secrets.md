---
type: open-question
status: answered
created: 2026-05-20
updated: 2026-06-18
author: claude-opus-4-7
tags: [github, webhooks, secrets, p1]
opened: 2026-05-20
answer-source: maintainer
importance: standard
---

# How do per-org GitHub Apps carry their own webhook secret without putting it in YAML?

> **ANSWERED (2026-06-18).** Receiver built as Cut A of
> [github-webhook-receiver](../plans/github-webhook-receiver.md) (branch
> next-release). Resolution: peek the unverified `installation.id` → connector →
> read that App's per-App sidecar `github-app-<appId>.webhook-secret`
> (materialized at boot from the `connector-apps` GSM blob), then HMAC-verify.
> The global `GITHUB_WEBHOOK_SECRET` is used ONLY for connectors on the global
> App — a per-org App is NEVER downgraded to it. None of options A/B/C: the GSM
> blob already persists per-App secrets, so no env-var-name scheme was needed.
> Full design + invariants in [webhook-receiver-design](../decisions/webhook-receiver-design.md).
> Original analysis retained below.
>
> **STATUS UPDATE (2026-06-18) — storage half answered, receiver half still open.**
> The original "how do we store per-App secrets without YAML" question has been
> overtaken by reality: secrets are now persisted durably via a 0600 sidecar
> file `~/.shipit/keys/github-app-<id>.webhook-secret` (written at manifest
> creation, `github-app-manifest-service.ts:294,307`) **and** a per-connector
> `webhookSecret` field inside the `connector-apps` GSM blob
> (`connector-app-store.ts:34-40,102-106,169-176`). This is a 4th mechanism, not
> options A/B/C — closest to C but without libsodium (relies on file mode 0600 +
> GSM-at-rest). The schema still carries a stale comment promising the Option-B
> `webhookSecretEnv` field (`shared/src/config/schema.ts:70-72`) that was never
> added.
>
> **Still open / still the live blocker:** the webhook **receiver** does not
> exist. `GitHubConnector.handleWebhook` is an empty stub
> (`connectors/github/src/connector.ts:165`), there is no `POST
/api/webhooks/github` route, and no HMAC/signature verification anywhere. To
> close this: (1) build the receiver + verify body; (2) add an
> `installation.id → connector → webhookSecret` lookup — the blob is keyed by
> connector id, NOT installation id, so an index is needed; (3) HMAC-verify with
> the resolved secret. The original A/B/C "lookup mechanism" decision is now moot
> for storage but the receiver's resolution path still needs designing.

## Context

V1 ships per-org App overrides for ID + private-key path ([per-org-github-app-override](../decisions/per-org-github-app-override.md)). Webhook ingestion is P1 — when it lands, the receiver needs to verify each delivery's HMAC signature with the **correct App's** webhook secret.

For the global App today, the secret lives in `GITHUB_WEBHOOK_SECRET` (env-only). The pattern works because there's exactly one secret to look up.

For per-org overrides, each App has its own webhook secret. Options:

| Option                                     | Mechanism                                                                                                 | Pro                            | Con                                                                                                                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Convention-based env-var lookup**     | For App `<id>`, look up `GITHUB_APP_<id>_WEBHOOK_SECRET`; fall back to `GITHUB_WEBHOOK_SECRET`.           | No YAML changes.               | Magic; an env-var with that literal name has to exist. App IDs aren't always shell-safe.                                                                                    |
| **B. Explicit env-var-name field in YAML** | `app: { id, privateKeyPath, webhookSecretEnv: "GITHUB_DEV_WEBHOOK_SECRET" }`. Loader resolves at runtime. | Explicit; flexible.            | Wizard has to write the env-var NAME, not the value — extra UX nuance.                                                                                                      |
| **C. Encrypted-at-rest secrets file**      | Separate gitignored file with libsodium-encrypted webhook secrets.                                        | UI can write secrets directly. | Adds master-key bootstrap; new infra. Already discussed and rejected for v1 ([github-connector-architecture-v1](../decisions/github-connector-architecture-v1.md) point 5). |

## Tried

Nothing yet — the webhook receiver isn't built. The setup guide says "all installations share the global secret in P0" deliberately so the question can sit until P1.

## What's Hard

- The webhook receiver doesn't know which connector a delivery belongs to until **after** signature verification (the receiver needs the secret to verify, but the secret depends on the connector). Resolution path: peek at the `installation.id` in the (unverified) payload, look up the connector by that ID, then verify with that connector's secret. Trusting unverified data for routing is OK if verification still happens before any state change.
- secretlint must not break the user's workflow. Option A is the easiest to keep clean (no secret-shaped strings in YAML); Option B is also clean (env-var NAMES aren't secrets).

## Recommendation (Not Yet Decided)

Option A first — convention-based with `GITHUB_APP_<id>_WEBHOOK_SECRET` and a fallback to the global. Simplest UX (no extra wizard field), the wizard documents the convention in the per-org-App copy.

## Who Can Answer

Maintainer / Mohamed. Decision needed **before** P1 webhook receiver merges — choosing the lookup mechanism is part of the receiver's signature.

## Related

- [per-org-github-app-override](../decisions/per-org-github-app-override.md)
- [github-connector-architecture-v1](../decisions/github-connector-architecture-v1.md)
