# GitHub Connector Setup

> **What's live:** polling on a schedule, webhook-driven refetches, and the
> knowledge facet (pull requests, issues, docs). Not emitted yet: first-class
> Environments, Deployments, workflow runs and branch-protection claims — the
> `entities.*` toggles for them exist in the config but nothing reads them.

ShipIt-AI uses a **GitHub App** to read repositories, teams, members, workflows
and CODEOWNERS from each org you want to map. Each org gets its own connector
instance in ShipIt-AI. This App is **not** the one people sign in with: login
uses a separate, classic GitHub OAuth App that the first-boot setup wizard or
**Admin → Settings** configures ([ADR-027](../adrs/ADR-027-login-and-access-model.md)).

There are **two ways to scope the App**:

| Path                                | When to use                                                                                                                                                                                                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **One App per org** _(the default)_ | Each org you want to sync owns a separate GitHub App, marked **Only on this account** (GitHub's default). Apps stay private — no public listing on `github.com/apps/`. A leaked key only reads the org that owns it. Right answer for most teams.                                 |
| **One shared App across orgs**      | One App installed in multiple orgs. Saves setup time but **requires marking the App public in GitHub** (App settings → "Where can this GitHub App be installed?" → _Any account_). Public Apps are discoverable on `github.com/apps/<slug>` and anyone can install them anywhere. |

This guide walks an org admin through:

0. **Manifest flow (recommended) — create a per-org App from the Connector Hub**
1. Pre-requisites
2. Creating the GitHub App manually
3. Installing it in your orgs
4. Generating a private key _(manual path)_
5. Configuring the API server _(manual and shared paths)_
6. Webhooks
7. Adding the connector in the ShipIt-AI UI
8. Rotation
9. **Shared App across multiple orgs** _(advanced — public App required)_
10. Uninstalling

## 0. Manifest flow (recommended)

The wizard's manifest flow creates an App marked **Only on this account**
(`public: false`), owned by the org and installable only there — exactly what
the "one App per org" pattern needs. Nothing is copied from GitHub's settings
pages by hand.

1. Start ShipIt-AI (`pnpm start:all`, or your deployment).
2. Open **Configure → Connector Hub**, click **Add connector** and choose the
   **GitHub** tile.
3. On the **App** step the **One App for this org** card is selected
   (recommended). Enter the **org login** the App should belong to (e.g.
   `acme-corp`); the wizard checks that the login exists before it continues.
4. Click **Create App on GitHub**. A new tab opens at github.com with a
   pre-filled "Register GitHub App" form scoped to your org. All permissions
   and events are already checked.
5. Click **Create GitHub App** at the bottom of GitHub's page. GitHub
   redirects to a ShipIt-AI page that confirms the App was created and tells
   you to switch back to the wizard tab.
6. The wizard claims the credentials from the server and fills **App ID**
   and **Private key path** automatically. The App's webhook secret was
   generated at the same time and stored beside the key — a per-org App needs
   no environment variable for it.
7. Click **Next**. On the **Connect** step, install the App on the org (the
   step links to GitHub's install page), then paste the installation ID (a
   per-org App does not use the installation picker, which lists installs of
   the shared App). **Test connection** probes the credentials and shows the
   account and a sample of repositories.
8. **Configure** (name, scope) → **Review** → **Create + sync**.

Repeat for each additional org — each one gets its own per-org App. To use an
App you created by hand instead, enter its **App ID** and **Private key path**
in the same card (§2–§4).

For the shared-across-orgs path (advanced — requires a public App), see §9.

> **Where the manifest writes the key**: by default `~/.shipit/keys/github-app-<id>.pem`
> with `chmod 600`, and the webhook secret next to it as
> `github-app-<id>.webhook-secret`. Override the directory with
> `SHIPIT_GITHUB_APP_KEY_DIR=/some/path` before starting the API server (in
> containers, mount a secrets volume there). Per-org credentials are stored on
> the connector instance (`app.id`, `app.privateKeyPath`); the shared path writes
> the global slot `connectors.github.app.*` instead. On a deployment that uses
> Google Secret Manager, per-org Apps and instances are also mirrored into the
> `connector-apps` secret and restored at boot, so a pod restart does not lose
> them ([ADR-025](../adrs/ADR-025-secrets-in-google-secret-manager.md)).

> **Localhost webhooks**: GitHub rejects webhook URLs that aren't publicly
> reachable. If `GITHUB_WEBHOOK_PUBLIC_URL` (or
> `connectors.github.app.webhookPublicUrl`) is unset or points at
> `localhost`/`127.0.0.1`/a private IP, the manifest omits the webhook and the
> launch page shows a yellow warning — you can either proceed (the App is
> created without a webhook; wire it later in the App's settings) or close the
> tab, set the URL to a smee.io channel or ngrok URL
> ([local-development.md §10](../local-development.md#10-webhooks-for-local-development)),
> restart the API server, and re-run the wizard.

> **Why not just make the App public?** A public App is listed on
> `github.com/apps/<slug>` and anyone with the URL can install it on their
> accounts. That's fine for tools intentionally distributed (CI integrations,
> code review bots), but for an internal observability tool most teams prefer
> to keep the App private and accept the per-org setup cost. See §9 if you
> want the shared path anyway.

## 1. Pre-requisites

- **GitHub org admin role** (or you have to ask one). The manifest flow
  creates the App in the org's settings.
- For the manual or shared path: the ability to set environment variables on
  the machine running the ShipIt-AI API server, or to edit its
  `shipit.config.local.yaml`.
- Optional, for local webhook delivery: Node 22 to run the
  [smee.io](https://smee.io) client.

## 2. Create the GitHub App manually

In GitHub, go to **Settings → Developer settings → GitHub Apps → New GitHub
App**. Use these values (they are what the manifest requests):

| Field                      | Value                                                                                                                                   |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub App name            | `ShipIt-AI <your-env>` (e.g. `ShipIt-AI dev`, `ShipIt-AI prod`)                                                                         |
| Homepage URL               | Your deployment URL                                                                                                                     |
| Webhook                    | Active; URL `https://<your-domain>/api/webhooks/github` (see §6)                                                                        |
| Webhook secret             | Generate one with `openssl rand -hex 32` (you'll give it to the API server in §5)                                                       |
| Repository permissions     | `Contents: Read`, `Metadata: Read`, `Actions: Read`, `Deployments: Read`, `Administration: Read`, `Pull requests: Read`, `Issues: Read` |
| Organization permissions   | `Members: Read`                                                                                                                         |
| Subscribe to events        | Push, Pull request, Issues, Issue comment, Workflow run, Deployment, Deployment status, Member, Membership, Team, Team add, Repository  |
| Where can it be installed? | **Only on this account** (or "Any account" if you want to share, §9)                                                                    |

Create the App. Note the numeric **App ID** at the top of the App's settings
page — you'll need it in §5.

## 3. Install the App in your orgs

A GitHub App is one entity in GitHub that gets **installed** separately
into each org or personal account that should grant it access.

**Through the ShipIt-AI wizard (shared App)**: on the Connect step the wizard
fetches every install of the shared App and lists them as a picker. Pick the
org and the installation ID is filled in. If the target org isn't in the list
yet, click **Install in another org ↗**: a new tab opens at GitHub's install
page for this App, you pick the org, click **Install**, close the tab, and the
picker refreshes when you return.

**Manually** (a per-org App, scripting, no UI access):

1. On the App's page in GitHub, click **Install App** in the left sidebar.
2. Click **Install** next to the org name.
3. Choose **All repositories** (recommended) or pick specific ones.
4. After install, the URL changes to
   `https://github.com/organizations/<org>/settings/installations/<INSTALLATION_ID>`.
   The trailing number is the installation ID.

> **Lost the URL? How to get the installation ID later.**
>
> - **For a personal-account install**: GitHub → your profile menu →
>   **Settings** → **Applications** (left sidebar) → **Installed GitHub
>   Apps** tab → find your App → click **Configure**. The URL becomes
>   `https://github.com/settings/installations/<INSTALLATION_ID>`.
> - **For an org install**: GitHub → the org's page → **Settings** (top
>   nav) → **Third-party Access** (left sidebar) → **GitHub Apps** →
>   click **Configure** next to your App. The URL becomes
>   `https://github.com/organizations/<org>/settings/installations/<INSTALLATION_ID>`.
>
> Either way, the trailing number in the URL is the installation ID. For the
> shared App the same list backs the wizard's picker, served by
> `GET /api/connectors/github/installations`.

## 4. Generate a private key

On the App's settings page, scroll to **Private keys → Generate a private
key**. Download the `.pem` file and move it into the API server's key
directory — `~/.shipit/keys/` by default (`SHIPIT_GITHUB_APP_KEY_DIR`). The
API server only accepts key paths that are files directly in that directory
(`PRIVATE_KEY_PATH_NOT_ALLOWED` otherwise).

> **Never** commit this file. ShipIt-AI's `secretlint` config will block it,
> and even if it didn't, anyone with the key can read every org the App is
> installed in.

## 5. Configure the API server (manual and shared paths)

A per-org App created by hand needs nothing here: enter its App ID and key
path in the wizard's App step (§0, step 8). The **shared** App is global
configuration, set either from the API / UI —

```bash
curl -X PUT http://localhost:3001/api/connectors/github/app \
  -H 'Content-Type: application/json' \
  -d '{"id": "12345", "privateKeyPath": "/home/you/.shipit/keys/github-app-12345.pem"}'
```

— or through environment variables before starting the API server:

```bash
# App identity (fills connectors.github.app.id / .privateKeyPath)
export GITHUB_APP_ID=12345
export GITHUB_APP_PRIVATE_KEY_PATH=$HOME/.shipit/keys/github-app-12345.pem

# Where GitHub posts webhooks: your public ingress, or a smee.io channel for local dev
export GITHUB_WEBHOOK_PUBLIC_URL=https://shipit.your-company.com/api/webhooks/github
```

The shared App's webhook secret is a registry secret (`github-webhook-secret`,
carried by `GITHUB_WEBHOOK_SECRET`). Either export it, or generate and
persist one from **Admin → Settings → Webhooks** — that works without a
restart and shows you the value to paste into GitHub.

On boot the API server logs `SyncScheduler attached to ConnectorRegistry` once
Redis is reachable; it says nothing about the App's credentials, which are
checked when a connector probes or syncs.

## 6. Webhooks

The receiver is `POST /api/webhooks/github` ([ADR-030](../adrs/ADR-030-github-webhook-receiver.md)).
It verifies each delivery's `X-Hub-Signature-256` against the App's secret —
a per-org App's from the file beside its key, the shared App's from the
settings above — answers `401` on a bad signature and `202` on a good one, and
queues a coalesced refetch: a `push` refetches the repository (including its
CODEOWNERS), a `workflow_run` its workflows. Other subscribed events are
accepted and ignored for now. Polling on the connector's `schedule` (default
`*/30 * * * *`) remains the backstop, so a lost delivery costs freshness, not
correctness.

In production, the App created by the manifest already points at
`<GITHUB_WEBHOOK_PUBLIC_URL>`; for a hand-made App set the webhook URL in its
settings to `https://<your-domain>/api/webhooks/github`. For local development
relay deliveries through smee.io or ngrok — the full walkthrough, including
how to verify a delivery, is
[local-development.md §10](../local-development.md#10-webhooks-for-local-development).

## 6b. Per-org GitHub Apps (the default)

This is the path the wizard defaults to: each connector instance owns its
App credentials directly, and the global App slot is used only by the shared
path (§9). Use per-org when:

| Reason                                | Example                                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| You don't want to mark the App public | GitHub requires public Apps for cross-account installs. Per-org keeps each App **Only on this account**.                   |
| Blast-radius isolation                | A leaked dev-org key shouldn't read prod. Create one App for dev orgs and another for prod orgs.                           |
| Independent tenants                   | If you're hosting ShipIt-AI for multiple unrelated customers, each customer creates their own App and you wire it per org. |

The override is persisted on the instance:

```yaml
connectors:
  instances:
    - id: github-prod
      type: github
      org: prod-org
      installationId: '55555'
      app:
        id: '654321'
        privateKeyPath: '/home/you/.shipit/keys/prod-app.pem'
```

Each field falls back to the global App independently — you can override
just the private key path while keeping the global App ID, for example. The
probe banner reads "Authenticated as App `<id>` (per-org override)" when the
override took effect.

To clear an override after the fact (revert to the global App), use the API:
`PATCH /api/connectors/:id` with `{"app": null}`. The detail drawer shows the
override but has no control to clear it yet.

## 7. Add the connector in ShipIt-AI

1. Open **Configure → Connector Hub** and click **Add connector**, then the
   **GitHub** tile.
2. **App step**: keep **One App for this org** and create the App (§0) or
   enter an existing one's ID and key path; or pick **One shared App across
   orgs** to use the global App (§9).
3. **Connect step**: for the shared App, the picker lists every org the App is
   installed in. Each row shows the org login, account type, and an
   **Already used by `<connector-id>`** pill when that installation already
   backs a connector (each installation can back only one). Click the target
   org — the wizard probes automatically and shows the account and sample
   repos.
   - If the target org isn't in the list, click **Install in another org
     ↗**, complete the install in the new tab, then return — the picker
     refreshes.
   - If the picker call fails (rate limit, network), expand **I don't see my
     org — paste an installation ID manually** and follow §3.
   - For a per-org App there is no picker: paste the installation ID and
     click **Test connection**.
4. **Configure step**: confirm the org name (probe-suggested), pick a
   connector ID and display name (sensible defaults from the org name), and
   set scope. By default the first 100 repos sync; check **Remove the safety
   cap** to lift it.
5. **Review** → **Create + sync**.

To add more orgs, repeat for each one. Each org becomes its own connector
card with independent status and run history.

### Knowledge facet (optional)

A connector can also index its repositories' pull requests, issues and
Markdown docs for the knowledge layer. It is switched on per connector over
the API (`PATCH /api/connectors/:id` with a `knowledge` block; no UI yet) and
walked through in [local-development.md §5](../local-development.md#5-running-the-stack).
Issues need the App's **Issues: Read** permission: Apps created by the current
manifest already request it; an older App's owner adds it under the App's
settings and an org owner approves the request GitHub emails. Until then the
knowledge runs succeed with the note `issues_permission_missing`.

## 8. Rotation

To rotate a private key:

1. Generate a new key in the App's settings (keep the old one active for now).
2. Replace the file at the path the connector uses — the instance's
   `app.privateKeyPath` for a per-org App, `$GITHUB_APP_PRIVATE_KEY_PATH` (or
   `connectors.github.app.privateKeyPath`) for the shared App.
3. Restart the API server: it memoizes key contents per path, and there is no
   reload signal.
4. Confirm **Connector Hub** still shows the orgs healthy.
5. Delete the old key from GitHub.

To rotate a webhook secret: **Admin → Settings → Webhooks → Rotate** generates
and persists a new one and shows the value to paste into the App's settings.

## 9. Shared App across multiple orgs (advanced)

Use this path only if you've accepted that your GitHub App will be marked
**public** on GitHub. Public Apps are listed on `github.com/apps/<slug>`
and anyone with the URL can install them. For an internal observability
tool that's usually undesirable; per-org Apps (§0–§7) are the default.

Both cards in the wizard's App step offer **Create App on GitHub**; the
shared card's version writes the App credentials to the global slot
(`connectors.github.app.*`), and any connector without a per-instance
override inherits it.

To use the shared path end-to-end:

1. **Pick "One shared App across orgs"** on the App step. The warning banner
   reminds you of the public-App requirement.
2. **Click "Create App on GitHub"** and complete the manifest flow, or enter
   an existing App's ID and key path.
3. **Make the App public** — the step GitHub doesn't expose in the manifest.
   In the App's settings (`github.com/settings/apps/<slug>` or
   `github.com/organizations/<owner>/settings/apps/<slug>`) → **Where can
   this GitHub App be installed?** → **Any account** → **Save changes**.
4. **Return to the wizard** → the **Connect** step's picker lists
   installations across orgs. Click **Install in another org ↗** to install
   the App on additional orgs (only works once the App is public).
5. Pick an installation, finish the wizard.

If you run the manifest flow but decide not to flip the App public, the App
still works for the org that owns it; you just can't install it elsewhere.

## 10. Uninstalling

When you uninstall the App from an org on GitHub, ShipIt-AI starts seeing
`401` responses on its polling cycle. The connector flips to `degraded` and
the last error appears in the detail drawer. To clean up:

1. Open the connector in **Connector Hub**.
2. Settings tab → **Delete connector…**
3. Confirm.

Deleting removes the connector's entry from the configuration, retires its
knowledge facet and marks what it indexed for removal, and deletes credential
files no other connector references. The graph data it ingested remains in
Neo4j: the GitHub connector does not mark absent nodes, so clear them with
the operations tools if you want a clean slate.

## Troubleshooting

| Symptom                                              | Likely cause                                                                                                                      |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Probe → `APP_NOT_CONFIGURED`                         | No shared App is configured, or the per-org override is missing its `id` or `privateKeyPath`.                                     |
| Probe → `PRIVATE_KEY_PATH_NOT_ALLOWED`               | The key path is not a file directly inside the key directory (`SHIPIT_GITHUB_APP_KEY_DIR`, default `~/.shipit/keys`).             |
| Probe → `PRIVATE_KEY_UNREADABLE` / `BAD_PRIVATE_KEY` | The file is missing or unreadable by the API server / the PEM is corrupt or doesn't match the App ID.                             |
| Probe → `AUTH_FAILED`                                | GitHub refused the App's JWT; check the App ID against the key.                                                                   |
| Probe → `INSTALLATION_NOT_FOUND`                     | The installation ID is wrong, or the App was uninstalled.                                                                         |
| Probe → `INSUFFICIENT_PERMISSIONS`                   | The App lacks a permission in §2 — update it and approve the request in the org.                                                  |
| Picker → `GITHUB_API_ERROR` or empty                 | GitHub's API refused or rate-limited the installations call, or the App isn't installed anywhere yet.                             |
| Wizard says "already used by `<id>`"                 | That installation already backs another connector. Pick a different org or delete the existing connector first.                   |
| Wizard keeps waiting after "Create GitHub App"       | The credential claim answers `NOT_READY` until GitHub's callback completes; finish the GitHub tab, or close it and start over.    |
| API logs `SyncScheduler init failed`                 | Redis is unreachable.                                                                                                             |
| Connector created but no entities appear in graph    | The first sync hasn't completed yet. Check the Runs tab for an error.                                                             |
| Knowledge runs note `issues_permission_missing`      | The App lacks **Issues: Read**; see §7, "Knowledge facet".                                                                        |
| Webhook deliveries fail with `401`                   | The secret GitHub signed with isn't the one the API server holds — rotate from **Admin → Settings → Webhooks** and update GitHub. |
