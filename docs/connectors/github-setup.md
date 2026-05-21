# GitHub Connector Setup

> **Status:** P0 (polling, multi-org). Webhook ingestion arrives in P1. Branch
> protection, Environments, Deployments, and first-class WorkflowRuns also
> land in P1.

ShipIt-AI uses a **GitHub App** to read repositories, teams, members, workflows,
and CODEOWNERS from each org you want to map. One App can be installed in many
orgs; each install becomes one connector instance in ShipIt-AI.

There are **two ways to set up the App**:

| Path                              | When to use                                                                                                                                                                                                                                                                                                                               |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Manifest flow** _(recommended)_ | The Connector Hub wizard creates the App on your behalf via GitHub's [App manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) flow. All permissions/events/webhook URL pre-filled. One click on GitHub's side, then the wizard auto-detects and configures the App. Skip to §0 below. |
| **Manual**                        | You already have an App, you can't create Apps on your account (rare), or you're scripting the setup. The original step-by-step walkthrough starts at §1.                                                                                                                                                                                 |

This guide walks an org admin through:

0. **Manifest flow (recommended) — Connector Hub does it for you**
1. Pre-requisites _(manual path)_
2. Creating the GitHub App _(manual path)_
3. Installing it in your orgs
4. Generating a private key _(manual path)_
5. Setting environment variables on the API server
6. (Optional in P0 / required in P1) Setting up webhook delivery for dev
7. Adding the connector in the ShipIt-AI UI
8. Rotation and uninstall

## 0. Manifest flow (recommended)

If you have a running ShipIt-AI instance and your browser can reach it:

1. Start ShipIt-AI normally (`pnpm start:all` or whichever start command you use).
2. Open <http://localhost:3000/connectors> and click **Add connector** → **GitHub**.
3. On step 1 (App), leave the default **Use one shared App for all my orgs** selected.
4. Optionally enter your **App owner** org (e.g. `acme-corp`). Leave blank to create the App on your personal GitHub account; you can transfer it to an org later.
5. Click **Create App on GitHub**. A new tab opens at github.com with a pre-filled "Register GitHub App" form. All the permissions and events ShipIt-AI needs are already checked.
6. Click **Create GitHub App** at the bottom. GitHub redirects you back to a ShipIt-AI page that confirms the App ID, private key file path, and webhook secret file path.
7. Set the webhook secret env var per the instructions on that page:
   ```bash
   export GITHUB_WEBHOOK_SECRET=$(cat ~/.shipit/keys/github-app-<id>.webhook-secret)
   ```
   Restart the API server so it picks up the env var.
8. Click **Return to ShipIt-AI**. The wizard you left open has auto-detected the new App. Click **Next**, paste your installation ID (you'll get this when you install the App on a specific org — see §3 below), then finish the wizard.

You're done. Skip to §3 for the install step. The wizard handles §5 (private key + App ID) automatically; you only need to wire the webhook secret per step 7 above.

> **Where the manifest writes the key**: by default, `~/.shipit/keys/github-app-<id>.pem` with `chmod 600`. Override the directory with `SHIPIT_GITHUB_APP_KEY_DIR=/some/path` before starting the API server (useful in containers — mount a tmpfs or secrets volume there).

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

On the App's page, click **Install App** in the left sidebar. For each org
you want ShipIt-AI to map:

1. Click **Install** next to the org name.
2. Choose **All repositories** (recommended) or pick specific ones.
3. After install, the URL changes to
   `https://github.com/organizations/<org>/settings/installations/<INSTALLATION_ID>`.
   Save the numeric `INSTALLATION_ID` somewhere — you'll paste it into the
   wizard.

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

## 6b. Per-org GitHub Apps (optional)

The default setup shares **one App** across all orgs. That's right for most
teams. You'll want a **separate App per connector** when:

| Reason                                      | Example                                                                                                                    |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Blast-radius isolation                      | A leaked dev-org key shouldn't read prod. Create one App for dev orgs and another for prod orgs.                           |
| Independent tenants                         | If you're hosting ShipIt-AI for multiple unrelated customers, each customer creates their own App and you wire it per org. |
| The App is locked to "Only on this account" | You can't reuse it elsewhere even if you wanted to.                                                                        |

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
3. Paste the **Installation ID** for one org. (App ID and private key are
   already loaded from env vars — you don't enter them here.)
4. Click **Test connection**. The wizard calls `/api/connectors/probe`,
   which authenticates against GitHub and reports the installation's account
   name plus a sample of accessible repos.
5. Confirm the org name. The wizard suggests a sensible connector ID and
   display name; you can override both.
6. Set scope. By default the first 100 repos sync; check **Remove the
   safety cap** to lift it (recommended once you've reviewed the scope on
   a small org).
7. Review and click **Create + sync**.

To add more orgs, repeat steps 2-7 for each Installation ID. Each org
becomes its own connector card with independent status.

## 8. Rotation

To rotate the private key:

1. Generate a new key in the App's settings (keep the old one active for now).
2. Replace the file at `$GITHUB_APP_PRIVATE_KEY_PATH`.
3. Restart the API server (it caches the key at startup; a `SIGHUP` reload
   path is on the roadmap).
4. Confirm `/connectors` still shows all orgs healthy.
5. Delete the old key from GitHub.

## 9. Uninstalling

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

| Symptom                                           | Likely cause                                                            |
| ------------------------------------------------- | ----------------------------------------------------------------------- |
| Wizard step 2 → `APP_NOT_CONFIGURED`              | `GITHUB_APP_ID` or `GITHUB_APP_PRIVATE_KEY_PATH` is missing on the API. |
| Wizard step 2 → `BAD_PRIVATE_KEY`                 | The PEM file is corrupt or doesn't match the App ID.                    |
| Wizard step 2 → `INSTALLATION_NOT_FOUND`          | The installation ID is wrong, or the App was uninstalled.               |
| Wizard step 2 → `INSUFFICIENT_PERMISSIONS`        | App permissions need an update — re-check §2.                           |
| API logs `SyncScheduler init failed`              | Redis is unreachable or App credentials don't load.                     |
| Connector created but no entities appear in graph | Initial sync hasn't completed yet. Check the Runs tab for an error.     |
