---
type: status
status: completed
created: 2026-06-18
updated: 2026-06-18
author: claude-session-2026-06-18-webhook-exec
branch: next-release
agent: claude-session-2026-06-18-webhook-exec
tags: [github, webhooks, hmac, connectors, event-bus, security]
---

# GitHub webhook receiver — Cut A implemented, uncommitted

Executes Cut A of [github-webhook-receiver](../plans/github-webhook-receiver.md)
(plan + 3-persona audit + post-impl code review all done). NOT yet committed
(standing rule: never commit/push without explicit approval).

## Scope landed (uncommitted, branch next-release)

- **shared**: `verifyGitHubWebhookSignature` (`auth/github-webhook.ts`, sha256,
  constant-time, trims sidecar-newline secret). schema.ts webhook-secret comment
  corrected.
- **api-server**: `services/webhook-resolution.ts` (installation→connector index
  - secret resolver with the INV-3 no-downgrade guard); `services/webhook-refetch-queue.ts`
    (coalesced BullMQ worker, colon-safe job ids, SETNX delivery-dedup, retention
    defaults, publish-rejection propagates); `routes/webhooks.ts` (verify-first
    handler); `server.ts` + `index.ts` wiring (queue construction, boot readiness
    assertion, shutdown); `require-auth.ts` (path added to PUBLIC_PATH_PREFIXES +
    SETUP_PUBLIC_PATHS).
- **connector-github**: `fetchers/single-entity.ts` (fetchRepository /
  fetchRepositoryWorkflows / fetchRepositoryCodeowners) + `connector.ts`
  refetchRepository/refetchRepositoryWorkflows.

## Verified

Full workspace `pnpm -r typecheck` clean. Tests green: api-server 335 (34 files;
new: webhooks route 15, webhook-resolution 9, webhook-refetch-queue 4),
shared 101 (HMAC 11), connector-github 42; all other packages unchanged-green.
Prettier clean on touched files.

## Security invariants (enforced + adversarially tested)

INV-1/2 verify-first (no state change pre-verify); INV-3 no secret downgrade
(per-org connector never uses global secret — tested with a forged delivery
signed by the present global secret); INV-4 selector/verified installation-id
match; INV-5 verified deliveries never 429'd. Review finding SC4 (pre-verify 202
enumeration oracle) fixed — both pre-verify 202s return an opaque `{ok:true}`.

## Explicitly deferred

- **Cut B** (separate PR): spec 6 content-freshness `_event_version` + a
  core-writer freshness guard + polling regression tests. Closes the
  [last-synced content-suppression](../investigations/last-synced-frozen-by-idempotency-dedup.md)
  follow-up. NOT in Cut A (a bare version bump lets out-of-order deliveries
  clobber newer state).
- `pull_request` / `installation` events: verified + 202-logged, no entity write.

## T10 closeout — DONE

[per-app-webhook-secrets](../open-questions/per-app-webhook-secrets.md) marked
answered; new [webhook-receiver-design](../decisions/webhook-receiver-design.md)
decision (incl. runbook + smee.io dev note);
[github-connector-architecture-v1](../decisions/github-connector-architecture-v1.md)
consequence updated.

## Post-commit hardening (2026-06-18, audit-driven, committed b46dcc7)

A ship-better-plans multi-persona audit (run against this code) found two real
issues, now fixed on top of the committed Cut A:

- **BLOCKER — dedup swallowed retries.** `markDeliverySeen` ran before `enqueue`;
  an enqueue failure (→5xx) left the dedup key set so GitHub's redelivery was
  202'd as a duplicate and the refetch was lost. Fix: `WebhookRefetchPort.releaseDelivery`
  - the receiver catch path DELs the dedup key on post-verify failure. Regression
    test added. See [scar](../scars/dedup-token-before-failable-side-effect-swallows-retry.md).
- **MAJOR — pre-verify disk read on an unthrottled route.** `readPerAppSecret` now
  caches by file mtime (rotation stays immediate). api-server tests 337 green.

## State

Cut A committed to `next-release` (aa43558); audit-driven hardening committed
(b46dcc7). Both pushed to `origin/next-release`. NO PR (user: "don't open a PR").
Cut B (spec 6) is the next PR. When this merges + deploys, archive this entry.
