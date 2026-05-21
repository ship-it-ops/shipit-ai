---
type: decision
status: active
created: 2026-05-20
updated: 2026-05-20
author: claude-opus-4-7
tags: [github, connectors, auth, multi-tenancy]
importance: core
---

# Per-org GitHub App override with field-by-field fallback to a shared App

## Context

First-pass v1 assumed one global GitHub App shared across all orgs. Real-world ask: some teams want a dedicated App per environment (dev/prod isolation) or per tenant (when ShipIt hosts data for multiple unrelated customers). The risk of "leaked dev key reads prod" is real.

## Decision

A connector instance may override the global App with its own credentials, **field by field**:

```yaml
connectors:
  github:
    app: { id: ${GITHUB_APP_ID:-}, privateKeyPath: ${...} }   # global
  instances:
    - id: github-prod
      app: { id: "654321", privateKeyPath: "/etc/shipit/keys/prod-app.pem" }   # override
```

Single source of truth for resolution is `resolveAppCredentials(connector, globalApp)` in `packages/shared/src/config/schema.ts`:

```ts
const id = connector.app?.id?.trim() || globalApp.id || null;
const path = connector.app?.privateKeyPath?.trim() || globalApp.privateKeyPath || null;
return { id, privateKeyPath, overridden: Boolean(overrideId || overrideKey) };
```

The scheduler (`SyncScheduler.processJob`), probe endpoint (`POST /api/connectors/probe`), and (P1) webhook router all call this helper so override semantics can't drift.

**Wizard UX**: step 1 of `AddGitHubConnectorWizard` asks shared-vs-per-org explicitly. First-run (no global configured) collects creds for whichever mode; subsequent runs show the existing global App as read-only info and only collect fields when per-org is picked.

**Webhook secret stays global in P0** — see [per-app-webhook-secrets](../open-questions/per-app-webhook-secrets.md).

## Alternatives Considered

- **Single global App only**: simplest, but fails the dev/prod isolation use case. Rejected.
- **Per-org App required (no global)**: avoids the override concept entirely but forces re-typing the same creds for every org in the common case. Bad first-run experience.
- **Whole-object override (no field-level fallback)**: simpler resolver, but loses the "override just the key path while keeping the App ID" use case that came up in design.

## Consequences

- The wizard's first-run flow must detect whether a global App exists. Backed by `GET /api/connectors/github/app` returning `{ configured, id, privateKeyPath }` plus an ETag.
- Persistence path:
  - Shared, new global: PUT `/api/connectors/github/app` writes `connectors.github.app.*` in `shipit.config.local.yaml`.
  - Per-org: connector POST's `app: { id, privateKeyPath }` lands on the instance only.
  - Clearing an override: PATCH connector with `app: null`.
- `GitHubAppService` mutates the in-memory `config.connectors.github.app` object in place so the scheduler picks up changes without restart — see [live-reference-for-hot-reload](../patterns/live-reference-for-hot-reload.md).
- 7 unit tests in `packages/shared/src/__tests__/resolve-app-credentials.test.ts` lock the resolver contract.

## Revisit Triggers

- P1 webhook receiver lands → need per-App webhook secrets. Either convention-based env-var name lookup or an explicit `webhookSecretEnv` field on `connector.app`.
- A second non-secret App field appears (e.g. client ID for OAuth flows) → resolver gets a third fallback branch.

## Related

- [github-connector-architecture-v1](./github-connector-architecture-v1.md)
- [etag-optimistic-concurrency-for-editable-config](./etag-optimistic-concurrency-for-editable-config.md) — the GET/PUT for global App use the same ETag pattern
- [live-reference-for-hot-reload](../patterns/live-reference-for-hot-reload.md) — why mutating in-memory propagates
- [per-app-webhook-secrets](../open-questions/per-app-webhook-secrets.md) — P1 gap
