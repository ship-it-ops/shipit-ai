---
type: decision
status: active
created: 2026-05-21
updated: 2026-05-21
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

- **Recommended path: manifest flow.** Wizard mints a CSRF state, opens github.com/.../settings/apps/new in a new tab with `manifest_url=<our-instance>/api/connectors/github/manifest&state=<token>`. The user clicks Create on GitHub's side. GitHub redirects to `/api/connectors/github/app-manifest-callback?code=…&state=…`. The callback exchanges the code via `POST /app-manifests/{code}/conversions`, receives `{ id, pem, webhook_secret, … }`, writes the PEM to `~/.shipit/keys/github-app-<id>.pem` (chmod 600), persists via `GitHubAppService.update()`. User returns to the wizard which polls and auto-detects the new App.
- **Manual path: collapsed `<details>` block** with the existing App ID / private-key-path fields. For users who already have an App or can't create one via manifest (rare).

The static template lives at `config/github-app-manifest.json`. The dynamic endpoint at `GET /api/connectors/github/manifest` substitutes `hook_attributes.url` and `redirect_url` per-instance from runtime config.

## Alternatives Considered

- **Skip the manifest flow, do docs-only fix**: rejected because the setup-step error rate doesn't drop materially with better docs alone — the user still has to click 30+ checkboxes correctly.
- **Manifest link only (no callback exchange)**: considered but rejected for the dual-hosting answer below. The user explicitly chose full callback.
- **Static manifest URL only (repo's raw URL)**: rejected because the manifest needs to know each instance's webhook + callback URLs. We ship both: a static template in the repo for documentation reference, and a dynamic endpoint that the wizard hands to GitHub.

## Consequences

- **Two new services**: `GitHubAppManifestService` (state tokens, template substitution, code exchange, PEM writer). Builds on `GitHubAppService` for persistence so the in-memory + YAML stay in sync via the live-reference pattern.
- **Two new HTTP endpoints**: `GET /api/connectors/github/manifest` (public, no secrets), `GET /api/connectors/github/app-manifest-callback` (returns HTML since GitHub navigates the user's browser).
- **PEM storage policy locked in**: written to `${SHIPIT_GITHUB_APP_KEY_DIR:-~/.shipit/keys}/github-app-{id}.pem` with `chmod 600`. The webhook secret returned by GitHub goes to a sidecar `.webhook-secret` file (also `chmod 600`) — we don't auto-set `GITHUB_WEBHOOK_SECRET` env var because that would require process-replacement, so the success page tells the user `export GITHUB_WEBHOOK_SECRET=$(cat …)`.
- **State token CSRF**: 24-byte hex token, 15-minute TTL, in-memory `Map`, single-use. Process restart loses pending states — user just re-clicks.
- **GitHub's conversion code is single-use and expires in ~60s** — user has to come straight back from the GitHub redirect. Network blips here just mean re-running the wizard.

## Revisit Triggers

- ShipIt grows multiple types of integrations that all need an OAuth-like setup → consider generalizing the manifest-callback pattern into a connector-agnostic primitive.
- The Hosted SaaS tier ([saas-tier-shared-github-app](../plans/saas-tier-shared-github-app.md)) ships → the manifest flow stays as the path customers use _to_ the hosted control plane, but the conversion happens server-side on ship-it-ops infra instead of the customer's instance.
- User OAuth lands ("Sign in with GitHub") → the conversion's `client_id` and `client_secret` outputs (which we currently discard) become useful and need a storage path.

## Related

- [github-connector-architecture-v1](./github-connector-architecture-v1.md) — auth model the manifest flow plugs into
- [per-org-github-app-override](./per-org-github-app-override.md) — manifest flow targets the _global_ App; per-org overrides remain manual today
- [live-reference-for-hot-reload](../patterns/live-reference-for-hot-reload.md) — why the callback can mutate `connectors.github.app.*` and have the scheduler pick it up without restart
- [etag-optimistic-concurrency-for-editable-config](./etag-optimistic-concurrency-for-editable-config.md) — manifest callback deliberately bypasses If-Match (destructive overwrite is the intent)
- [saas-tier-shared-github-app](../plans/saas-tier-shared-github-app.md) — future state where ship-it-ops owns the App centrally
