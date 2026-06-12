---
type: decision
status: active
created: 2026-05-21
updated: 2026-05-22
author: claude-opus-4-7
tags: [github, manifest, onboarding, secrets]
importance: core
---

# Use GitHub's App manifest flow for one-click App creation

## Context

The original wizard required users to: create a GitHub App by hand, click 18 permission checkboxes, check 10 event boxes, generate a private key, download a PEM, paste the App ID + installation ID back into the wizard. Every step is a chance to misconfigure. The user (Mohamed) flagged this as a setup-friction problem worth solving.

Three options on the table:

1. **ship-it-ops hosts a shared App** — rejected because the self-hosted model would require distributing the private key to every customer machine. One leaked customer = the App compromised across every install.
2. **Continue with manual setup, improve docs only** — incremental but ignores GitHub's actual solution for this problem.
3. **GitHub App manifest flow** — GitHub's purpose-built mechanism for "open-source tool wants a properly-configured GitHub App without owning customer credentials".

Picked #3.

## Decision

The Connector Hub wizard offers two paths in step 1:

- **Recommended path: manifest flow** (POST form, not URL parameter). Wizard's "Create App on GitHub" button opens `/api/connectors/github/manifest/launch?owner=<org>` in a new tab. That same-origin endpoint returns an HTML page containing `<form method="POST" action="https://github.com/.../settings/apps/new?state=<token>"><input name="manifest" value="<json>"></form>` plus a script that submits it. The browser POSTs to GitHub; GitHub renders a pre-filled App-creation page (permissions + events + webhook URL all set). User clicks Create. GitHub redirects to `/api/connectors/github/app-manifest-callback?code=…&state=…`. The callback exchanges the code via `POST /app-manifests/{code}/conversions`, receives `{ id, pem, webhook_secret, … }`, writes the PEM to `~/.shipit/keys/github-app-<id>.pem` (chmod 600), persists via `GitHubAppService.update()`. The wizard polls `useGitHubAppStatus` while the manifest tab is open and auto-detects the new App on return.
- **Manual path: collapsed `<details>` block** with the existing App ID / private-key-path fields. For users who already have an App or can't create one via manifest (rare).

The static template lives at `packages/api-server/config/github-app-manifest.json`. The dynamic JSON endpoint at `GET /api/connectors/github/manifest` returns the substituted manifest for inspection (curl-friendly), but is not what the wizard hands to GitHub — that's the role of `GET /api/connectors/github/manifest/launch`, which returns the auto-submitting HTML form.

**Why a server-rendered form, not a client-side cross-origin POST**: GitHub's manifest mechanism requires a POST form whose action is `github.com/.../settings/apps/new?state=...` and whose body carries the manifest as a `manifest` field. The wizard's "Create App on GitHub" click can't fetch state asynchronously and then submit a cross-origin form in a new tab — popup blockers and async-after-user-gesture rules make that fragile. The launch endpoint is the cleanest solution: same-origin URL → reliable `window.open` → server-issued state baked into the form action → auto-submit on page load.

**Trap to avoid**: an earlier draft tried to pass `manifest_url=<json-endpoint>&state=<token>` as query parameters to github.com. GitHub silently ignored the unknown `manifest_url` param and rendered an empty App-creation form — there is no GitHub-side fetch of `manifest_url`. The only supported transport is the POST form body. Anyone reading our manifest service who's tempted to "simplify" back to a GET URL: don't.

**Three traps GitHub validates on the manifest server-side** (discovered when the POST form mechanism finally worked):

1. **Webhook URL must be publicly reachable** — `localhost`, `127.0.0.1`, `::1`, and RFC-1918 private ranges produce _"Hook url is not supported because it isn't reachable over the public Internet"_. The manifest service omits `hook_attributes` entirely when the configured `webhookPublicUrl` looks non-public. See `checkWebhookUrlPublic()` in `github-app-manifest-service.ts`.
2. **`default_events` and `hook_attributes` are a coupled pair** — sending events without a valid hook URL fails with _"Hook url cannot be blank"_ / _"Hook is invalid"_. The service must strip BOTH together when the webhook URL is non-public; sending events alone is illegal. The launch HTML's warning explains this to the user; they proceed with permissions-only (events + webhook configured later via GitHub's App settings) or back out and set `GITHUB_WEBHOOK_PUBLIC_URL`.
3. **`default_events` must align with `default_permissions`** — subscribing to `pull_request` requires `pull_requests: read`. GitHub returns _"Default events are not supported by permissions: pull_request"_ if you skip the matching permission. Same coupling applies to every event/permission pair. The static template at `packages/api-server/config/github-app-manifest.json` is the single place to keep them in sync; whenever a new event is added there, audit the docs to find the matching permission.

## Alternatives Considered

- **Skip the manifest flow, do docs-only fix**: rejected because the setup-step error rate doesn't drop materially with better docs alone — the user still has to click 30+ checkboxes correctly.
- **Manifest link only (no callback exchange)**: considered but rejected for the dual-hosting answer below. The user explicitly chose full callback.
- **Static manifest URL only (repo's raw URL)**: rejected because the manifest needs to know each instance's webhook + callback URLs. We ship both: a static template in the repo for documentation reference, and a dynamic endpoint that the wizard hands to GitHub.

## Consequences

- **Two new services**: `GitHubAppManifestService` (state tokens, template substitution, code exchange, PEM writer). Builds on `GitHubAppService` for persistence so the in-memory + YAML stay in sync via the live-reference pattern.
- **Three new HTTP endpoints**: `GET /api/connectors/github/manifest` (JSON, debug-only), `GET /api/connectors/github/manifest/launch` (auto-submitting HTML form — the actual entry point the wizard opens), `GET /api/connectors/github/app-manifest-callback` (returns HTML since GitHub navigates the user's browser).
- **PEM storage policy locked in**: written to `${SHIPIT_GITHUB_APP_KEY_DIR:-~/.shipit/keys}/github-app-{id}.pem` with `chmod 600`. The webhook secret returned by GitHub goes to a sidecar `.webhook-secret` file (also `chmod 600`) — we don't auto-set `GITHUB_WEBHOOK_SECRET` env var because that would require process-replacement, so the success page tells the user `export GITHUB_WEBHOOK_SECRET=$(cat …)`.
- **State token CSRF**: 24-byte hex token, 15-minute TTL, in-memory `Map`, single-use. Process restart loses pending states — user just re-clicks.
- **GitHub's conversion code is single-use and expires in ~60s** — user has to come straight back from the GitHub redirect. Network blips here just mean re-running the wizard.

## Revisit Triggers

- ShipIt grows multiple types of integrations that all need an OAuth-like setup → consider generalizing the manifest-callback pattern into a connector-agnostic primitive.
- The Hosted SaaS tier ([saas-tier-shared-github-app](../plans/saas-tier-shared-github-app.md)) ships → the manifest flow stays as the path customers use _to_ the hosted control plane, but the conversion happens server-side on ship-it-ops infra instead of the customer's instance.
- User OAuth lands ("Sign in with GitHub") → the conversion's `client_id` and `client_secret` outputs (which we currently discard) become useful and need a storage path.

## Update 2026-05-24 — target-routing extension (per-org manifest flow)

The launch endpoint now accepts `?target=global|instance` and (for
`target=instance`) a `&nonce=<uuid>` the wizard supplies. The state
token records both, and the callback routes the exchange result based
on `target`:

- `target=global` (default): existing behavior — `GitHubAppService.update()`
  writes credentials to `connectors.github.app.*`. Used by the shared
  card.
- `target=instance`: write the PEM + webhook-secret sidecar to disk as
  usual but DO NOT touch the global App slot. Stash credentials in an
  in-memory `pendingInstance: Map<nonce, {appId, privateKeyPath, ...}>`
  with the same 15-minute TTL as the state map.

A new endpoint `GET /api/connectors/github/manifest/pending-instance/:nonce`
returns + clears the pending entry (single-use). The wizard's per-org
card generates a nonce client-side, threads it through the launch URL,
and polls every 2 s while the user is in the GitHub tab. When the
callback fires, the next poll claims the credentials and fills the
`overrideAppId` + `overrideKeyPath` fields on the connector instance.

This lets the per-org card offer the same one-click "Create App on
GitHub" UX as the shared card, without ever writing to the global slot
the user explicitly opted out of by picking per-org mode.

The success page copy is also tailored: `target=instance` says "your
wizard tab will fill these fields automatically — switch back" rather
than "the shared GitHub App is now configured."

## Related

- [github-connector-architecture-v1](./github-connector-architecture-v1.md) — auth model the manifest flow plugs into
- [per-org-github-app-override](./per-org-github-app-override.md) — per-org credentials live on the connector instance; the manifest flow can now target either slot
- [per-org-github-app-is-default-not-shared](./per-org-github-app-is-default-not-shared.md) — why per-org is the wizard's recommended default and why the manifest flow had to learn about that
- [live-reference-for-hot-reload](../patterns/live-reference-for-hot-reload.md) — why the callback can mutate `connectors.github.app.*` and have the scheduler pick it up without restart
- [etag-optimistic-concurrency-for-editable-config](./etag-optimistic-concurrency-for-editable-config.md) — manifest callback deliberately bypasses If-Match (destructive overwrite is the intent)
- [saas-tier-shared-github-app](../plans/saas-tier-shared-github-app.md) — future state where ship-it-ops owns the App centrally
