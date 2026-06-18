---
type: decision
status: active
created: 2026-05-20
updated: 2026-05-20
author: claude-opus-4-7
tags: [github, connectors, architecture]
importance: core
---

# GitHub Connector v1 — auth, multi-org, webhooks, persistence

## Context

The GitHub connector started life as a single-org PoC: PAT or GitHub App auth, no real persistence, `triggerSync` was a `setTimeout` stub, the AddConnectorDialog didn't submit anywhere. Making this the first real integration required deciding ten things at once — captured in the plan at `ClaudePlans/09-github-integration-v1.md` and `~/.claude/plans/great-we-are-in-mellow-cosmos.md`.

## Decision

The 10 foundational choices, all in force as of v1:

1. **Auth**: GitHub App only. PAT path removed. Cleanest path for multi-org and higher per-installation rate-limit budget.
2. **Multi-org**: one connector instance per org. Reuses the existing per-instance shape; one App can be installed into many orgs.
3. **Entity coverage**: current set (Repository, Team, Person, Pipeline, CODEOWNERS) hardened — branch protection, Environments, Deployments, WorkflowRuns deferred to P1.
4. **Freshness**: webhooks + polling reconciliation (defense in depth; polling catches missed events).
5. **Secrets**: env vars + file paths. App ID/installation ID in YAML; private key path + webhook secret env-only. secretlint blocks pasted secrets per ADR-017.
6. **Editable**: yes, via API with ETag concurrency (ADR-016 pattern — see [etag-optimistic-concurrency](./etag-optimistic-concurrency-for-editable-config.md)).
7. **UI surface**: Connector Hub at `/connectors` only — no onboarding-wizard step in v1.
8. **Persistence**: on-disk YAML under `shipit.config.local.yaml` `connectors.instances[]` (see [top-level-connectors-config](./top-level-connectors-config-section.md)).
9. **Webhook delivery**: smee.io relay for dev, direct ingress for prod.
10. **Default scope**: all repos, capped at 100 until user confirms expansion.

## Alternatives Considered

- **PAT support kept as an escape hatch**: rejected. Worse for multi-org, single-user, low rate limit, token expires. Doc says to create an App.
- **One connector, list of orgs**: rejected. Per-org sync status and pause/resume become awkward; the discriminated-union `instances[]` shape stays clean.
- **Hierarchy: tenant → orgs**: overkill for v1.
- **Webhooks only**: missing initial seed path; any missed event causes drift.
- **All-in connector**: shipping PRs, Issues, Reviews — 2-3x the work, high-volume webhooks, deferred to a future phase.

## Consequences

- `Repository`, `Team`, and `Pipeline` canonical IDs are now org-scoped (`shipit://<label>/default/<org>/<name>`) — see [canonical-id-org-namespacing](./canonical-id-org-namespacing.md). `Person` stays unscoped because GitHub logins are globally unique.
- A leaked App private key reads every org the App is installed in. Mitigated by **per-org App override** (see [per-org-github-app-override](./per-org-github-app-override.md)) for orgs that need isolation.
- The webhook receiver now resolves per-App webhook secrets at receive time from the per-App sidecar (global secret only for the global App) — see [webhook-receiver-design](./webhook-receiver-design.md). Closes the former P1 [open question](../open-questions/per-app-webhook-secrets.md).

## Revisit Triggers

- A user request for PR/Issue/Review entities → expand the connector or split into a sibling sub-connector.
- Webhook delivery via smee.io becomes a friction point in dev → consider built-in ngrok or Cloudflare Tunnel guidance.
- Connector instance count > ~50 → YAML round-trip gets slow; revisit SQLite persistence.

## Related

- [top-level-connectors-config-section](./top-level-connectors-config-section.md) — why connectors sit at the root, not under backend
- [per-org-github-app-override](./per-org-github-app-override.md) — shared vs per-org App resolution
- [etag-optimistic-concurrency-for-editable-config](./etag-optimistic-concurrency-for-editable-config.md) — ETag pattern shared with the schema editor
- [connector-runner-injection](../patterns/connector-runner-injection.md) — how the scheduler plugs into the registry
- [canonical-id-org-namespacing](../open-questions/canonical-id-org-namespacing.md) — only breaking change called out in v1
- [per-app-webhook-secrets](../open-questions/per-app-webhook-secrets.md) — P1 question
