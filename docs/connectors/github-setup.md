# GitHub Connector Setup

> **Status:** P0 (polling, multi-org). Webhook ingestion arrives in P1. Branch
> protection, Environments, Deployments, and first-class WorkflowRuns also
> land in P1.

ShipIt-AI uses a **GitHub App** to read repositories, teams, members, workflows,
and CODEOWNERS from each org you want to map. Each org gets its own connector
instance in ShipIt-AI.

There are **two ways to scope the App**:

| Path                                | When to use                                                                                                                                                                                                                                                                       |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **One App per org** _(recommended)_ | Each org you want to sync owns a separate GitHub App, marked **Only on this account** (GitHub's default). Apps stay private — no public listing on `github.com/apps/`. A leaked key only reads the org that owns the App. Right answer for most teams.                            |
| **One shared App across orgs**      | One App installed in multiple orgs. Saves setup time but **requires marking the App public in GitHub** (App settings → "Where can this GitHub App be installed?" → _Any account_). Public Apps are discoverable on `github.com/apps/<slug>` and anyone can install them anywhere. |

This guide walks an org admin through:

0. **Manifest flow (recommended) — create a per-org App via the Connector Hub**
1. Pre-requisites
2. Creating the GitHub App manually
3. Installing it in your orgs
4. Generating a private key _(manual path)_
5. Setting environment variables on the API server
6. (Optional in P0 / required in P1) Setting up webhook delivery for dev
7. Adding the connector in the ShipIt-AI UI
8. Rotation
9. **Shared App across multiple orgs** _(advanced — public App required)_
10. Uninstalling

## 0. Manifest flow (recommended)

The wizard's manifest flow creates an App marked **Only on this account**
(`public: false`). The App is private to its owner — installable in the
org that owns it, and only there. That's exactly what the "one App per
org" pattern needs: each org gets its own App, scoped to it.

If you have a running ShipIt-AI instance and your browser can reach it:

1. Start ShipIt-AI normally (`pnpm start:all` or whichever start command you use).
2. Open <http://localhost:3000/connectors> and click **Add connector** → **GitHub**.
3. On step 1 (App), the default is **One App for this org** (recommended).
4. Enter the **Org login** for the org this App should belong to (e.g. `acme-corp`). Required — the App is created in that org's settings, scoped to it.
5. Click **Create App on GitHub**. A new tab opens at github.com with a pre-filled "Register GitHub App" form scoped to your org. All permissions and events are already checked.
6. Click **Create GitHub App** at the bottom of GitHub's page. GitHub redirects you back to a ShipIt-AI page that confirms the App was created. The page tells you to switch back to your wizard tab — credentials auto-fill there.
7. The wizard's polling effect claims the credentials from the server and fills the **App ID** + **Private key path** fields automatically. A toast confirms.
8. (Optional for P0, required for P1 webhook ingestion) Set the webhook secret env var per the success page:
   ```bash
   export GITHUB_WEBHOOK_SECRET=$(cat ~/.shipit/keys/github-app-<id>.webhook-secret)
   ```
   Restart the API server so it picks up the env var.
9. Click **Next** in the wizard. Install the App on the org (the wizard's Connect step has an **Install in another org ↗** link that opens the install page), then come back, paste the installation ID, finish.

Repeat for each additional org — each one gets its own per-org App.

For the shared-across-orgs path (advanced — requires public App), see §9.

> **Where the manifest writes the key**: by default, `~/.shipit/keys/github-app-<id>.pem` with `chmod 600`. Override the directory with `SHIPIT_GITHUB_APP_KEY_DIR=/some/path` before starting the API server (useful in containers — mount a tmpfs or secrets volume there). Same for both per-org and shared paths — only the _YAML destination_ of the App ID + key path differs (per-org → connector instance's `app` field; shared → top-level `connectors.github.app.*`).

> **Where the manifest writes the key**: by default, `~/.shipit/keys/github-app-<id>.pem` with `chmod 600`. Override the directory with `SHIPIT_GITHUB_APP_KEY_DIR=/some/path` before starting the API server (useful in containers — mount a tmpfs or secrets volume there).

> **Localhost webhooks**: GitHub rejects webhook URLs that aren't publicly reachable. If `GITHUB_WEBHOOK_PUBLIC_URL` is unset (or points at `localhost`/`127.0.0.1`/private IPs), the manifest service drops `hook_attributes` from the spec and the launch page shows a yellow warning — you can either proceed (the App is created without webhook config; you wire it up later via GitHub's App settings) or close the tab, set `GITHUB_WEBHOOK_PUBLIC_URL` to a smee.io channel or ngrok URL, restart the API server, and re-run the wizard. The latter gets you the full one-click experience.

> **Why not just make the App public?** A public App is listed on `github.com/apps/<slug>` and anyone with the URL can install it on their accounts. That's fine for tools intentionally distributed (CI integrations, code review bots), but for an internal observability tool most teams prefer to keep the App private and accept the per-org setup cost. See §9 if you want the shared path anyway.

## 1. Pre-requisites

- **GitHub org admin role** (or you have to ask one).
- Ability to set environment variables on the machine running the ShipIt-AI
  API server. The private key path and webhook secret are loaded from `env`,
  not from `shipit.config.local.yaml`, because they're secrets.
- (P1, optional) Node 22 if you'll use the [smee.io](https://smee.io) client
  to relay webhooks during local development.

## 2. Create the GitHub App

In GitHub, go to **Settings → Developer settings → GitHub Apps → New GitHub
App**. Use these values:

| Field                      | Value                                                                                                                |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| GitHub App name            | `ShipIt-AI <your-env>` (e.g. `ShipIt-AI dev`, `ShipIt-AI prod`)                                                      |
| Homepage URL               | `https://shipit.local` (or your real deployment URL)                                                                 |
| Webhook                    | Active (set the URL in §6; for P0 you can leave it unchecked)                                                        |
| Webhook secret             | Generate one with `openssl rand -hex 32` (you'll set this in §5)                                                     |
| Repository permissions     | `Contents: Read`, `Metadata: Read`, `Actions: Read`                                                                  |
| Organization perms         | `Members: Read`                                                                                                      |
| Subscribe to events        | (P1) Push, Pull request, Workflow run, Deployment, Deployment status, Member, Membership, Team, Team add, Repository |
| Where can it be installed? | **Only on this account** (or "Any account" if you want to share)                                                     |

Create the App. Note the numeric **App ID** at the top of the App's settings
page — you'll need it in §5.

## 3. Install the App in your orgs

A GitHub App is one entity in GitHub that gets **installed** separately
into each org or personal account that should grant it access. The wizard
handles the rest, but you need to do the install in GitHub first.

**Through the ShipIt-AI wizard (recommended)**: when you reach the Connect
step, the wizard fetches every install of the App across orgs and lists
them as a picker. Pick the org and you're done — installation IDs are
filled in automatically. If the target org isn't in the list yet, click
**Install in another org ↗**: a new tab opens at GitHub's install page
for this App, you pick the org, click **Install**, close the tab, and the
wizard's picker auto-refreshes when you return.

**Manually** (scripting, no UI access, etc.):

1. On the App's page in GitHub, click **Install App** in the left sidebar.
2. Click **Install** next to the org name.
3. Choose **All repositories** (recommended) or pick specific ones.
4. After install, the URL changes to
   `https://github.com/organizations/<org>/settings/installations/<INSTALLATION_ID>`.
   The trailing number is the installation ID.

> **Lost the URL? How to get the installation ID later (fallback only).**
> The wizard's picker is the easiest path — this fallback exists for
> scripting, or for cases where the picker call fails. To find an
> installation ID by hand:
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
> Either way, the trailing number in the URL is the installation ID.
> The same list backs the wizard's picker, served by
> `GET /api/connectors/github/installations` (which proxies GitHub's
> `GET /app/installations` with the global App's JWT).

## 4. Generate a private key

On the App's settings page, scroll to **Private keys → Generate a private
key**. Download the `.pem` file and move it somewhere outside the repo —
e.g. `~/.shipit/github-app.pem`.

> **Never** commit this file. ShipIt-AI's `secretlint` config will block it,
> and even if it didn't, anyone with the key can read every org the App is
> installed in.

## 5. Set environment variables

Add these to your shell, `.env` file, or container environment:

```bash
# Required — App identity
export GITHUB_APP_ID=12345
export GITHUB_APP_PRIVATE_KEY_PATH=$HOME/.shipit/github-app.pem

# Required for P1 webhook ingestion; safe to set now
export GITHUB_WEBHOOK_SECRET=<the-secret-you-generated-in-step-2>

# Dev only — where GitHub posts webhooks. Point at smee.io for local dev
# or at your prod ingress in deployed environments.
export GITHUB_WEBHOOK_PUBLIC_URL=https://smee.io/<your-channel>
```

Restart the API server. On boot, ShipIt-AI logs `SyncScheduler attached to
ConnectorRegistry` if the App credentials are valid and Redis is reachable.

## 6. (P1) Set up webhook delivery for dev

In production, point the App's webhook URL at your API server's
`/api/webhooks/github` endpoint over HTTPS.

In local development, use [smee.io](https://smee.io):

```bash
# Pick any channel ID — it's just a random URL on smee.io
npx smee-client --url https://smee.io/<channel> --target http://localhost:3001/api/webhooks/github
```

Set the App's webhook URL to the same `https://smee.io/<channel>` value.
Smee will relay every webhook GitHub posts there to your local API.

> **P0 note:** the receiver isn't wired up yet, so smee delivery is
> currently a no-op. Polling on the connector's `schedule` (default
> `*/15 * * * *`) is what keeps the graph fresh.

## 6b. Per-org GitHub Apps (the recommended default)

This is the path the wizard defaults to. Each connector instance owns its
App credentials directly; the global App slot is only used by the shared
path (§9). Use per-org when:

| Reason                                | Example                                                                                                                    |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| You don't want to mark the App public | GitHub requires public Apps for cross-account installs. Per-org keeps each App **Only on this account**.                   |
| Blast-radius isolation                | A leaked dev-org key shouldn't read prod. Create one App for dev orgs and another for prod orgs.                           |
| Independent tenants                   | If you're hosting ShipIt-AI for multiple unrelated customers, each customer creates their own App and you wire it per org. |

To use a separate App for an org:

1. Repeat §2-§4 to create a second App and download a second private key.
2. Place the key file somewhere on the API server (e.g.
   `/etc/shipit/keys/prod-app.pem`). **Do not** check it into the repo.
3. In the wizard's **Prepare** step, expand "Use a separate GitHub App for
   this org" and enter the new App ID + path to its private key.
4. Click **Test connection**. The success banner will read "Authenticated
   as App `<id>` (override active)" if the override took effect.
5. Finish the wizard normally.

The override is persisted to `shipit.config.local.yaml` as:

```yaml
connectors:
  instances:
    - id: github-prod
      type: github
      org: prod-org
      installationId: '55555'
      app:
        id: '654321'
        privateKeyPath: '/etc/shipit/keys/prod-app.pem'
```

Each field falls back to the global App independently — you can override
just the private key path while keeping the global App ID, for example.

To clear an override after the fact (revert to the global App), use the API
directly with `PATCH /api/connectors/:id` and `{"app": null}` — the
detail-drawer UI for this lands in P1.

## 7. Add the connector in ShipIt-AI

1. Open `/connectors` in the UI.
2. Click **Connect GitHub**.
3. **App step**: the wizard auto-detects the global App (set up via §0 or
   §2-§5). Click **Next**.
4. **Connect step**: the picker lists every org the App is installed in.
   Each row shows the org login, account type, and an **Already used by
   `<connector-id>`** pill when that installation is wired to an existing
   connector (each installation can back only one connector). Click the
   target org — the wizard runs the probe automatically and shows the
   account + sample repos when it succeeds.
   - If the target org isn't in the list, click **Install in another org
     ↗**, complete the install in the new tab, then return to the wizard
     tab — the picker auto-refreshes.
   - If the picker call fails (rate limit, network), expand the **I don't
     see my org — paste an installation ID manually** disclosure and
     follow the fallback in §3.
5. **Configure step**: confirm the org name (probe-suggested), pick a
   connector ID and display name (sensible defaults from the org name),
   and set scope. By default the first 100 repos sync; check **Remove the
   safety cap** to lift it.
6. **Review** → **Create + sync**.

To add more orgs, repeat for each one. Each org becomes its own connector
card with independent status. Per-org App overrides (§6b) skip the picker
because they're using a different App PEM than the global one — paste the
installation ID manually in that case.

## 8. Rotation

To rotate the private key:

1. Generate a new key in the App's settings (keep the old one active for now).
2. Replace the file at `$GITHUB_APP_PRIVATE_KEY_PATH`.
3. Restart the API server (it caches the key at startup; a `SIGHUP` reload
   path is on the roadmap).
4. Confirm `/connectors` still shows all orgs healthy.
5. Delete the old key from GitHub.

## 9. Shared App across multiple orgs (advanced)

Use this path only if you've accepted that your GitHub App will be marked
**public** on GitHub. Public Apps are listed on `github.com/apps/<slug>`
and anyone with the URL can install them. For an internal observability
tool that's usually undesirable; per-org Apps (§0-§7) are the default.

The wizard's manifest "Create App on GitHub" button is wired to this
path — it writes the App credentials to the global slot in
`shipit.config.local.yaml` (`connectors.github.app.*`), and any connector
without a per-instance override inherits it.

To use the shared path end-to-end:

1. **Pick "One shared App across orgs"** on Step 1 of the wizard. The
   warning banner reminds you of the public-App requirement.
2. **Click "Create App on GitHub"**, complete the manifest flow.
3. **Make the App public** — this is the step GitHub doesn't expose in
   the manifest. After creation, go to your App's settings:
   `github.com/settings/apps/<slug>` (personal) or
   `github.com/organizations/<owner>/settings/apps/<slug>` (org-owned)
   → scroll to **Where can this GitHub App be installed?** → choose
   **Any account** → **Save changes**.
4. **Return to the wizard** → the **Connect** step picker now lists
   installations across orgs. Click **Install in another org ↗** to
   install the App on additional orgs (only works once the App is
   public).
5. Pick an installation, finish the wizard.

If you start the wizard, run the manifest flow, but decide not to flip
the App public — the App still works fine for the org that owns it, you
just won't be able to install it elsewhere. Switch back to **One App
for this org** and you're back on the per-org path.

## 10. Uninstalling

When you uninstall the App from an org on GitHub, ShipIt-AI will start
seeing 401 responses on its polling cycle. The connector flips to
`degraded` and the last error appears in the detail drawer. To clean up:

1. Open the connector in `/connectors`.
2. Settings tab → **Delete connector…**
3. Confirm.

The connector's YAML entry is removed from `shipit.config.local.yaml`. The
graph data it ingested remains in Neo4j; clear it via the operations
tools if you want a clean slate.

## Troubleshooting

| Symptom                                           | Likely cause                                                                                                    |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Wizard step 2 → `APP_NOT_CONFIGURED`              | `GITHUB_APP_ID` or `GITHUB_APP_PRIVATE_KEY_PATH` is missing on the API.                                         |
| Wizard step 2 → `BAD_PRIVATE_KEY`                 | The PEM file is corrupt or doesn't match the App ID.                                                            |
| Wizard step 2 → `INSTALLATION_NOT_FOUND`          | The installation ID is wrong, or the App was uninstalled.                                                       |
| Wizard picker is empty                            | The App isn't installed in any org yet — click **Install in another org ↗**.                                    |
| Wizard says "already used by `<id>`"              | That installation already backs another connector. Pick a different org or delete the existing connector first. |
| Wizard step 2 → `INSUFFICIENT_PERMISSIONS`        | App permissions need an update — re-check §2.                                                                   |
| API logs `SyncScheduler init failed`              | Redis is unreachable or App credentials don't load.                                                             |
| Connector created but no entities appear in graph | Initial sync hasn't completed yet. Check the Runs tab for an error.                                             |
