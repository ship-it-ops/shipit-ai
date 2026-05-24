---
type: decision
status: active
created: 2026-05-24
updated: 2026-05-24
author: claude-opus-4-7
tags: [github, connectors, wizard, ux]
importance: core
---

# Wizard Connect step surfaces the App's installations as a picker

## Context

A user with a shared GitHub App configured globally (org A wired as the
first connector) tried to add a second connector for org B. They selected
"Use the shared GitHub App" on step 1, reached the Connect step, and saw
a single "Installation ID" textbox with no way to discover what to type.
They pasted the only installation ID they had — org A's. The probe
correctly authenticated against org A (an installation ID _is_ what
selects the target installation under GitHub's auth model — see
[per-org-github-app-override](./per-org-github-app-override.md)),
the success banner read "Connected to org-a", and the Configure step
defaulted org to org-a. From the user's perspective the wizard "tested
against the wrong org."

Two adjacent gaps in the same UX:

1. **No discovery.** Nothing in the wizard listed the orgs the shared
   App was installed in.
2. **No path to install in another org.** GitHub Apps must be installed
   explicitly into each org. The wizard never said so or linked to the
   install page.

Architecturally nothing was wrong — global App + per-instance
`installationId` is the model
[github-connector-architecture-v1](./github-connector-architecture-v1.md)
point 2 picked, and it matches GitHub's own. The wizard simply hid that
model from the user.

## Decision

Add a new read endpoint `GET /api/connectors/github/installations` that
authenticates with the shared App's JWT (no installation context) and
returns the merged shape:

```ts
{
  appSlug: string;
  appName: string;
  installUrl: string; // ${html_url}/installations/new
  installations: Array<{
    id: number;
    account: { login; type; avatarUrl };
    targetType: 'User' | 'Organization';
    repositorySelection: 'all' | 'selected';
    usedByConnectorId: string | null; // joined from registry.list()
  }>;
}
```

The wizard's Connect step renders these as an **InstallationPicker** when
`mode === 'shared' && globalConfigured` — the only branch where the
server has the App keys necessary to call `/app/installations`. Picker
behaviors:

- Selecting a row sets `installationId = String(inst.id)` and fires the
  probe in the same tick (pass-by-arg override on `handleProbe` avoids
  the React state-update race).
- Rows tagged `usedByConnectorId !== null` show an "Used by `<id>`" pill
  and the duplicate guard blocks Next so two connectors can't claim the
  same installation.
- "Install in another org ↗" links to `installations.installUrl` in a new
  tab. The react-query hook uses `refetchOnWindowFocus: true`, so
  returning to the wizard tab after the install auto-refreshes the
  picker.
- Manual ID entry survives behind a collapsed `<details>` ("I don't see
  my org — paste an installation ID manually") for users whose picker
  call fails or whose target installation isn't listed.

In per-org-override mode the picker is suppressed entirely — the user is
providing their own App PEM inline, and the server has no way to call
`/app/installations` for an App it doesn't hold keys for. Manual entry
stays primary there.

## Alternatives Considered

- **Persist the App slug** on `connectors.github.app.*` to avoid the
  per-request `apps.getAuthenticated()` lookup. Rejected — one extra API
  call is cheap, and reading the slug live avoids staleness if the
  user renames the App in GitHub.
- **Single-call merge** of `/app` + `/app/installations` into one wrapper
  endpoint vs two client calls. Picked the wrapper because the wizard
  needs both atomically and `usedByConnectorId` is server-only
  information.
- **Auto-install via the manifest's `setup_url`** so GitHub redirects the
  user back after a new install — rejected for the same reason webhook
  URLs are: requires a publicly-reachable URL and breaks in localhost
  dev. Deferred; a future enhancement when the SaaS tier ships.
- **Remove manual entry entirely** once the picker exists — rejected
  because per-org mode still legitimately needs it.

## Consequences

- **New helper exported from connector-github**: `createAppJWTOctokit`
  (auth.ts). Distinct from `authenticateGitHubApp`, which is installation-
  scoped. Anyone adding a future App-level endpoint reuses this.
- **API endpoint contract**: 404 NO_APP_CONFIGURED (first-run), 400
  PRIVATE_KEY_UNREADABLE (key missing on disk), 502 GITHUB_API_ERROR
  (upstream rejection — 401 from GitHub is mapped to BAD_PRIVATE_KEY
  for symmetry with the probe endpoint).
- **Duplicate-installation guard** is one of the wizard's first
  cross-connector invariants enforced in UI. Future picker-style flows
  for other connector types should mirror it.
- **3 new api-server tests** cover the 404, 200, and 502 paths. No
  wizard integration test was added — the repo has zero
  WizardDialog-driven tests today, and introducing one would be a large
  precedent for marginal value. Manual end-to-end verification covers
  the picker.

## Revisit Triggers

- A user has the App installed in >100 orgs → add pagination to the
  endpoint (currently `per_page: 100`, no follow-up).
- The per-org-override flow needs picker support → probe the override
  App's installations after the PEM is provided inline.
- The SaaS tier ships → `installUrl` flips from the customer's App
  page to the hosted control plane's install URL.

## Related

- [github-connector-architecture-v1](./github-connector-architecture-v1.md) — `installationId` is the org selector
- [per-org-github-app-override](./per-org-github-app-override.md) — why per-org mode skips the picker
- [github-app-manifest-flow](./github-app-manifest-flow.md) — `installUrl` computed the same way (`${html_url}/installations/new`)
- [live-reference-for-hot-reload](../patterns/live-reference-for-hot-reload.md) — the global App reference the picker depends on
