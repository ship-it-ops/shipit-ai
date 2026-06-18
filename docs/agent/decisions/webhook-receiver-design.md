---
type: decision
status: active
created: 2026-06-18
updated: 2026-06-18
author: claude-session-2026-06-18-webhook-exec
tags: [github, webhooks, hmac, security, event-bus, connectors]
importance: core
---

# GitHub Webhook Receiver — design & operational model

## Context

The connector had a stubbed `handleWebhook` and no receiver route; freshness came
from polling alone. The v1 architecture
([github-connector-architecture-v1](./github-connector-architecture-v1.md))
always intended webhooks + polling as defense-in-depth. The open question
[per-app-webhook-secrets](../open-questions/per-app-webhook-secrets.md) blocked it
on a secret-resolution decision. Built as Cut A of
[github-webhook-receiver](../plans/github-webhook-receiver.md) (plan audited by a
3-persona panel; code reviewed post-impl).

## Decision

`POST /api/webhooks/github` (public allow-list; **HMAC is the entire auth
boundary**). The handler ordering is fixed and is the security contract:

1. Header pre-check (`x-github-event`, `x-github-delivery`, `x-hub-signature-256`).
2. Parse a COPY of the unverified body for the `installation.id` **selector only**.
3. Route to connector(s) via a per-request `installation.id → connector` index
   (built from `registry.list()`, never cached). Unknown → opaque `202`.
4. Resolve the secret (below). None → opaque `202`.
5. **Verify HMAC** over the raw bytes — first non-2xx auth result.
6. Re-parse the verified bytes; assert the selector installation id matches.
7. Dedup `X-GitHub-Delivery` (Redis SETNX, 600s) **before** any refetch.
8. Dispatch: `push`→repo refetch, `workflow_run`→workflows refetch (both async,
   coalesced); `ping`→200; everything else verified + `202`-logged.

**Processing = targeted refetch, not payload translation.** A verified delivery
enqueues a coalesced BullMQ job (`WebhookRefetchQueue`) that refetches just the
affected entity and runs it through the EXISTING per-entity normalizers →
`eventBus.publish` → core-writer. Polling remains the reconciliation backstop and
the documented max-lag recovery window.

**Secret resolution (resolves the open question):** per-App sidecar
`<keyDir>/github-app-<appId>.webhook-secret` (materialized at boot from the
`connector-apps` GSM blob), with the global `GITHUB_WEBHOOK_SECRET` used **only**
for connectors on the global App. A per-org (App-overridden) connector with no
sidecar secret is NEVER downgraded to the global secret.

## Alternatives Considered

- **Global secret only** — rejected: breaks per-org Apps (the default deployment),
  each of which has its own webhook secret.
- **Convention env-var `GITHUB_APP_<id>_WEBHOOK_SECRET` (Option A) / explicit
  `webhookSecretEnv` field (Option B)** — superseded: the `connector-apps` GSM
  blob + sidecar already persists per-App secrets durably, so no env-var scheme is
  needed.
- **Coarse `registry.triggerSync` per delivery** — rejected: full org re-scan per
  webhook, rate-limit risk.
- **Direct payload→canonical translation** — rejected: payload ≠ full entity,
  drift risk, new per-event mappers.
- **Synchronous in-request refetch** — rejected: blocks the handler on a GitHub
  round-trip; redelivery storms would fan out unbounded calls.

## Security invariants (enforced + adversarially tested)

- **INV-1/2** verify-first: no state-changing action (dedup, enqueue, write) runs
  before verification; no pre-verify path returns a 2xx that represents processing.
- **INV-3** no secret downgrade; unknown installation never verifies against global.
- **INV-4** selector vs. verified installation-id consistency (duplicate-key JSON safe).
- **INV-5** verified deliveries are never 429'd (rate limiting off on the route;
  transient publish failure → 5xx so GitHub redelivers, never an auto-disable storm).
- Pre-verify 202s return an **opaque** body (no enumeration oracle); the
  unknown-installation vs no-secret distinction lives only in server logs.

## Consequences

- Reachable during first-boot setup mode (in `SETUP_PUBLIC_PATHS`) so GitHub gets
  a `202` instead of a 401-storm that auto-disables the webhook.
- A boot readiness assertion warns loudly for any connector whose App id resolves
  but has no materialized secret ("should-exist-but-missing").
- Coalesced refetch job ids and the dedup key avoid `:` (BullMQ-5 scar); the queue
  carries the same retention defaults as the sync scheduler (Redis-OOM scar).

## Operational notes / runbook

- **Local dev:** point the App's webhook at a smee.io relay →
  `http://localhost:3001/api/webhooks/github` (per v1 architecture #9).
- **Webhook disabled by GitHub:** caused by a non-2xx storm. Check for `BAD_SIGNATURE`
  (secret mismatch / un-materialized sidecar) or `webhook_processing_failed` (event
  bus down) in api-server logs; re-enable in the App's Advanced → Recent Deliveries.
- **Secret rotation:** rotate in GitHub → the new secret rides the `connector-apps`
  GSM blob and is re-materialized to the sidecar on next boot; restart to pick up.
- **Replay / catch-up:** polling (`schedule`, default `*/15`) reconciles anything a
  missed delivery dropped; `event-bus/replay.ts` exists but is unwired (see
  [replay-stream-wire-or-cut](../open-questions/replay-stream-wire-or-cut.md)).
- **Watch:** `unknown_installation` / `no_resolvable_secret` / `BAD_SIGNATURE` /
  `webhook_processing_failed` log codes.

## Revisit Triggers

- PRs/Issues/Reviews become graph entities → wire `pull_request` (currently
  verified + 202-logged) to real refetch/mapping.
- Out-of-order delivery clobbering becomes observable → ship Cut B (content-freshness
  `_event_version` + core-writer freshness guard).
- Connector count grows enough that the per-request index matters → cache + invalidate.

## Related

- [github-webhook-receiver](../plans/github-webhook-receiver.md) — the plan
- [per-app-webhook-secrets](../open-questions/per-app-webhook-secrets.md) — closed by this
- [github-connector-architecture-v1](./github-connector-architecture-v1.md) — webhooks+polling intent
- [connector-apps-gsm-blob-durability](./connector-apps-gsm-blob-durability.md) — how the secret reaches the pod
- [bullmq-5-forbids-colons-in-queue-names-and-job-ids](../scars/bullmq-5-forbids-colons-in-queue-names-and-job-ids.md)
- [redis-memory-limit-below-dataset-oomkills](../scars/redis-memory-limit-below-dataset-oomkills.md)
