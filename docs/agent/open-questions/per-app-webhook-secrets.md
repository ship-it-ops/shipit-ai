---
type: open-question
status: active
created: 2026-05-20
updated: 2026-05-20
author: claude-opus-4-7
tags: [github, webhooks, secrets, p1]
opened: 2026-05-20
answer-source: maintainer
importance: standard
---

# How do per-org GitHub Apps carry their own webhook secret without putting it in YAML?

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
