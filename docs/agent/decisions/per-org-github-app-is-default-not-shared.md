---
type: decision
status: active
created: 2026-05-24
updated: 2026-05-24
author: claude-opus-4-7
tags: [github, connectors, wizard, ux, security]
importance: core
---

# Per-org GitHub App is the wizard default; shared is opt-in and requires a public App

## Context

The original
[github-connector-architecture-v1](./github-connector-architecture-v1.md)
chose "one App, installed in many orgs" as point 2, on the assumption
that one App across orgs was a clean trade — easier setup, slight blast-
radius cost. The
[per-org-github-app-override](./per-org-github-app-override.md) decision
added a per-instance override for teams that wanted isolation, but kept
shared as the recommended UI default.

The user (Mohamed) hit the GitHub constraint that breaks that assumption:
**a GitHub App marked "Only on this account" (the default,
`public: false` in the manifest) can only be installed in the account
that owns it.** To install one App in multiple orgs you have to flip
"Where can this GitHub App be installed?" to **Any account**, which makes
the App public — listed on `github.com/apps/<slug>` and installable by
anyone with the URL.

For an internal observability tool that's the wrong trade. The user
rejected it explicitly: "I am not a fan of this approach and now think it
makes more sense for us to be separate app for each org first and have
the global as the secondary option."

## Decision

The wizard now defaults to **per-org App**. The shared path is still
supported and selectable, but explicitly opt-in.

Specifics:

- `mode` initial state in `AddGitHubConnectorWizard` is `'per-org'` (was
  `'shared'`).
- The Step 1 card order is **per-org first, shared second**. Per-org
  carries the `recommended` badge; shared does not.
- Per-org card copy emphasizes "App stays private (Only on this
  account)" and links to the manual-create docs (`§2`) for users who
  don't have an App yet.
- Shared card copy explicitly says "requires marking your App public in
  GitHub". When the user actually picks shared mode, a warning Banner
  appears reinforcing the public-App requirement and the public-listing
  consequence.
- The manifest "Create App on GitHub" button is now wired in BOTH cards:
  - Shared card → `target=global` (legacy behavior; writes to `connectors.github.app.*`)
  - Per-org card → `target=instance&nonce=<uuid>` (callback stashes
    credentials in an in-memory pending-instance map keyed by the
    wizard's nonce; the wizard polls
    `GET /api/connectors/github/manifest/pending-instance/:nonce` and
    fills the override fields on the connector instance only).
    See [github-app-manifest-flow-instance-target](./github-app-manifest-flow.md) for the target-routing extension.
- `docs/connectors/github-setup.md` reorganized: §0 is "create per-org
  Apps via the manifest flow (each org gets its own App)", §6b is "Per-
  org Apps (the recommended default)", and the new §9 is "Shared App
  across multiple orgs (advanced — public App required)".

## Alternatives Considered

- **Keep shared as default, add a clearer warning before users hit the
  installation step.** Rejected — the user research already pointed at
  per-org as the better default, and warnings don't change the fact that
  the wizard's first-run flow steered them into a setup they can't
  complete without making the App public.
- **Wire the manifest flow to support per-org targets** (so the manifest
  button works in the per-org card too, writing credentials to a
  pending-instance slot the wizard reads on Create). Initially deferred,
  then landed in a follow-up commit alongside this decision — see the
  Decision section above for the wiring details.
- **Remove the shared path entirely.** Rejected — some teams genuinely
  do want a public App (e.g. demoing the tool, hosting a ShipIt-AI
  instance multiple unrelated teams point their own orgs at). Keep it as
  an advanced opt-in.

## Consequences

- The
  [github-connector-architecture-v1](./github-connector-architecture-v1.md)
  decision's point 2 ("one App can be installed into many orgs") is no
  longer the recommended default. The architecture still **supports**
  it; the wizard just doesn't lead with it.
- The
  [per-org-github-app-override](./per-org-github-app-override.md)
  decision still applies — the `resolveAppCredentials` resolver
  behavior is unchanged. What changed is which side of the override
  the wizard puts the user on first.
- The
  [github-installation-picker](./github-installation-picker.md) endpoint
  (`GET /api/connectors/github/installations`) only fires in shared
  mode (`globalConfigured`). Per-org mode skips the picker because
  there's no global App to query — same code path as before. Per-org
  users enter their installation ID manually.
- `config/github-app-manifest.json` already specifies `"public": false`,
  which matches the new default — no manifest change needed.

## Revisit Triggers

- The "manifest flow targeted at per-org" enhancement ships → per-org
  users get a one-click create path too, and the per-org card body
  gets its own "Create App on GitHub" button.
- The SaaS tier ships
  ([saas-tier-shared-github-app](../plans/saas-tier-shared-github-app.md))
  → the hosted control plane will offer a single, central public App
  customers install into their orgs; the per-org default flips back to
  shared _in the hosted UI_ but stays per-org in the self-hosted
  default.

## Related

- [github-connector-architecture-v1](./github-connector-architecture-v1.md) — original "one App, many orgs" assumption that this decision narrows
- [per-org-github-app-override](./per-org-github-app-override.md) — the `resolveAppCredentials` mechanism is unchanged
- [github-app-manifest-flow](./github-app-manifest-flow.md) — manifest button currently writes to global only; per-org targeting is a future enhancement
- [github-installation-picker](./github-installation-picker.md) — picker is shared-only; per-org mode falls back to manual ID entry
- [saas-tier-shared-github-app](../plans/saas-tier-shared-github-app.md) — where shared-by-default would make sense again
