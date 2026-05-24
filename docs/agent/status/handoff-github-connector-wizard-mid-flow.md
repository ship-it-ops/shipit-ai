---
type: status
status: active
created: 2026-05-22
updated: 2026-05-22
author: claude-opus-4-7
branch: main
agent: handoff-to-next-session
tags: [github, connector, wizard, manifest-flow, handoff]
importance: core
---

# Handoff — mid-flow on GitHub connector wizard end-to-end testing

## TL;DR (read this first)

We just shipped GitHub Connector v1 + the App manifest flow + a multi-step wizard end-to-end this session. The user is **actively walking through the wizard for the first time** and surfacing real bugs as they go. Most recently they completed App creation via manifest flow, created a connector instance, and discovered that **`Sync now` did nothing and the card showed "disconnected"** — which we just fixed (scheduler was gated on App-being-configured-at-boot; refactored to attach eagerly).

**UPDATE 2026-05-22 (next session):** The eager-attach fix WAS correct, but a separate BullMQ 5 validation error (`:` forbidden in queue names) was being silently caught by the same try/catch — the registry kept its NoopRunner and the card was stuck in the `enabled-but-no-runs` fallback that paints as `degraded`/`syncing`. Renaming the queue from `shipit:sync:github` → `shipit-sync-github` lets the scheduler attach. A second BullMQ 5 colon trap then surfaced in the event-bus producer (`opts.jobId` was `${connectorId}:${node.id}:${version}` with canonical URIs containing `:`); fixed by globally replacing `:` with `~` in `buildIdempotencyKey`. Manual sync verified end-to-end: `status: success, entitiesSynced: 29`. See `scars/bullmq-5-forbids-colons-in-queue-names-and-job-ids.md`.

## First thing you must do

Follow the ship-agent-context protocol. In order:

1. Read `docs/agent/MANIFEST.md` (you may have already — the SessionStart hook usually injects it).
2. Read every file in `docs/agent/status/` — this one, plus anything else there.
3. Read every `importance: core` decision and pattern. There are several worth your time:
   - `decisions/github-connector-architecture-v1.md` — the 10 foundational choices for the connector
   - `decisions/per-org-github-app-override.md` — `resolveAppCredentials` and the wizard's shared-vs-per-org logic
   - `decisions/top-level-connectors-config-section.md` — why `connectors:` is at the YAML root, not under `backend:`
   - `decisions/etag-optimistic-concurrency-for-editable-config.md` — the pattern used by `SchemaService`, `ConnectorRegistry`, `GitHubAppService`
   - `decisions/github-app-manifest-flow.md` — captures three GitHub validation traps we hit in sequence
   - `patterns/connector-runner-injection.md` — Registry ↔ Runner contract (just updated)
   - `patterns/live-reference-for-hot-reload.md` — why mutating `config.connectors.github.app.*` propagates without restart
4. Read every scar:
   - `scars/web-ui-cannot-import-mcp-server-root.md` — `node:fs` bundling trap (older session)
   - `scars/github-app-manifest-is-post-not-get.md` — the `manifest_url=` query-param mistake (this session)
5. Skim `open-questions/canonical-id-org-namespacing.md` and `open-questions/per-app-webhook-secrets.md` — both are core to where the connector goes next.

Time budget: ~10 minutes. If you skip this and start coding, you will repeat work or contradict prior decisions.

## Currently in flight

The user is at this exact step of the wizard end-to-end test:

1. ✅ Opened `/connectors` → **Add connector** → **GitHub** → wizard opened at "App" step.
2. ✅ Selected "Use one shared App for all my orgs".
3. ✅ Clicked **Create App on GitHub** → manifest launch endpoint opened a new tab → POST form auto-submitted to github.com → GitHub created the App with permissions only (webhook URL was localhost so we stripped `hook_attributes` + `default_events` to avoid GitHub's validation rejection).
4. ✅ Clicked **Create GitHub App** on GitHub's side → callback fired → PEM written to `~/.shipit/keys/github-app-<id>.pem` (chmod 600) → `GitHubAppService.update()` persisted App ID + key path into `connectors.github.app.*`.
5. ✅ Returned to wizard, status auto-detected as `configured: true`, advanced to **Connect** step.
6. ✅ Got the installation ID (we just added inline docs explaining how to find it via Settings → Configure).
7. ✅ Probe succeeded, completed wizard, connector instance landed in `connectors.instances[]`.
8. ❌ **Card showed "disconnected", `Sync now` was inert** — root-caused to the scheduler-gate bug.
9. ✅ **Fix shipped** — scheduler now attaches eagerly when Redis is available; `connectorInfo()` derivation handles `runtime.state === 'running'` and "enabled but no runs yet" properly. **NOT YET VERIFIED BY USER.** They need to restart the API server.

**Your first message to the user should be along the lines of**: "Welcome back. Last I knew, you'd restarted the API server after the scheduler-attach fix and were about to click Sync now in the drawer. Did the first sync run successfully, or did you hit another issue?"

## What was just shipped this session (file paths)

Backend:

- **`packages/api-server/src/services/github-app-manifest-service.ts`** — NEW. Manifest template loader, state-token issuance, code-for-credentials exchange via `POST https://api.github.com/app-manifests/{code}/conversions`, PEM writer (chmod 600 at `~/.shipit/keys/github-app-{id}.pem`, override with `SHIPIT_GITHUB_APP_KEY_DIR`), webhook-secret sidecar writer. `checkWebhookUrlPublic()` exported helper detects localhost/private-IP webhook URLs.
- **`packages/api-server/src/routes/connectors.ts`** — significant additions:
  - `GET /api/connectors/github/manifest` — JSON manifest for inspection (debug only, NOT what the wizard hands to GitHub).
  - `GET /api/connectors/github/manifest/launch?owner=<org-or-blank>` — **the real entry point** — returns an HTML page with an auto-submitting `<form method="POST" action="https://github.com/.../settings/apps/new?state=<token>">` carrying the manifest JSON in a `manifest` field. The form submits to GitHub on page load. Includes a warning UI + held-back auto-submit when webhook URL is non-public.
  - `GET /api/connectors/github/app-manifest-callback` — exchanges GitHub's redirect code for App credentials, persists, redirects user back to `/connectors?from=app-manifest`.
- **`packages/api-server/src/services/github-app-service.ts`** — NEW (earlier in session). Owns `connectors.github.app.{id, privateKeyPath}` with ETag concurrency.
- **`packages/api-server/src/services/sync-scheduler.ts`** — BullMQ-backed runner. Resolves App credentials per-job via `resolveAppCredentials(connector, this.globalApp)`. Cache PEM contents keyed on file path.
- **`packages/api-server/src/services/connector-registry.ts`** — Registry holding connector instances, runs per-instance hash for ETag, atomic YAML round-trip via `parseDocument`+`setIn`.
- **`packages/api-server/src/index.ts`** — **just modified**: removed `hasAnyGitHubConfig` gate. Scheduler attaches whenever `backend.redis.url` is reachable. Logs a clear warning when Redis is absent.

Frontend:

- **`packages/web-ui/src/components/connectors/add-github-connector-wizard.tsx`** — 4-step wizard (App → Connect → Configure → Review). Step 1 has shared-vs-per-org radio cards with `AppModeCard` (which is a `<div>` not a `<button>` — see the hydration-fix history in that file's header comment). Step 1's "Create App on GitHub" button opens the manifest launch URL in a new tab and sets `manifestPending` to poll `useGitHubAppStatus` every 2s. Cancel link inside the pending state. Installation ID step has inline help with the **Configure**-link recovery path.
- **`packages/web-ui/src/components/connectors/add-connector-picker.tsx`** — type picker dialog (GitHub + 5 "Coming soon" entries).
- **`packages/web-ui/src/components/connectors/connector-detail-drawer.tsx`** — drawer with Overview / Runs / Scope / Settings tabs. Sync now lives in Overview.
- **`packages/web-ui/src/lib/api.ts`** — `buildManifestLaunchUrl()` helper (NOT `buildManifestRedirectUrl` — that was the broken `manifest_url=` approach we removed). `connectorInfo()` derivation **just modified**: handles `running` runtime + "enabled but no runs" → `degraded` (visually `syncing`).

Config:

- **`config/github-app-manifest.json`** — static template, includes `pull_requests: read` permission to match the `pull_request` event subscription (without it GitHub rejects with "Default events are not supported by permissions").
- **`shipit.config.yaml`** + `shipit.config.local.example.yaml` — top-level `connectors:` section with `github.app.*` and `instances: []`.

Docs:

- **`docs/connectors/github-setup.md`** — leads with the manifest flow at §0; manual setup is the fallback. §3 has the "lost the URL?" callout (Settings → Configure).
- **`docs/connectors.md`** — Authentication section lists both paths.
- **`docs/local-development.md`** — §9 leads with manifest flow.
- **`docs/agent/`** — 14 notes total, see MANIFEST.

## Test posture

```
shared:          47 tests
event-bus:       18 tests
mcp-server:      59 tests
connector-sdk:   25 tests
core-writer:     39 tests
connector-github: 27 tests
web-ui:          56 tests
api-server:      81 tests  ← grew the most this session (manifest flow + ETag CRUD + probe)
───────────────────────
TOTAL:          352 tests, all green
```

`pnpm turbo build` and `pnpm turbo typecheck` are also green across all 14 tasks.

## Known issues & open questions

| Area                                                                              | Status                                                                                                                                   | Where it lives                                                                                       |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Webhook receiver                                                                  | NOT IMPLEMENTED (P1). The whole `POST /api/webhooks/github` HMAC-verified ingress is on the plan but not coded.                          | `decisions/github-connector-architecture-v1.md` point 4; `open-questions/per-app-webhook-secrets.md` |
| Branch protection / Environments / Deployments / WorkflowRun connector fetchers   | NOT IMPLEMENTED (P1). Schema additions also not in `config/shipit-schema.yaml`.                                                          | `decisions/github-connector-architecture-v1.md` point 3                                              |
| Repository canonical IDs don't include org → multi-org collision                  | KNOWN BREAKING change; not yet acted on. Decide before any production multi-org use.                                                     | `open-questions/canonical-id-org-namespacing.md`                                                     |
| Per-org App webhook secrets                                                       | UNRESOLVED for P1. Three options on the table; recommendation is convention-based env-var lookup.                                        | `open-questions/per-app-webhook-secrets.md`                                                          |
| `pnpm turbo build` on web-ui sometimes fails with `node:fs` external-module error | The `configure/mcp/page.tsx` (added in a prior session) imports a server-only path. Captured as a scar; not in our current scope to fix. | `scars/web-ui-cannot-import-mcp-server-root.md`                                                      |

## Likely-next things the user will ask for

In rough priority order based on the flow so far:

1. **Verify the scheduler-attach fix actually works.** First sync should complete, card should flip to "connected" / "healthy". If it fails, the Runs tab will have the specific error — most likely an installation ID mismatch or a private-key-path issue in the persisted config.
2. **More wizard UX bugs as testing continues.** Things like: error states when probe fails partway through, what happens if you cancel mid-create, what happens if the installation is uninstalled from GitHub side while a sync is running, etc.
3. **Webhook ingestion (P1)**. The user keeps asking about webhooks. They'll eventually want to actually receive a delivery and see the graph update.
4. **The shipit-ai-plugin handoff** (separate repo) — there's a plan at `ClaudePlans/10-shipit-ai-plugin-handoff.md` for a Claude Code plugin that ships an MCP config. Not started.
5. **Real auth** — the dev-user identity stub is still in place. ADR-015 captures the design. `plans/mcp-access-stage-2-real-login.md` covers the auth-token surface for MCP.

## What NOT to do without checking first

- **Don't restart the user's API server yourself.** Ask them whether they've restarted before assuming the bug is fixed.
- **Don't add Personal Access Token support back** — explicitly removed in v1, see decision point 1.
- **Don't centralize the GitHub App in ship-it-ops** for self-hosted users — see `plans/saas-tier-shared-github-app.md` for why that's deferred.
- **Don't use `manifest_url=` as a GitHub query param** to try to "simplify" the manifest flow back to a GET. See the scar at `scars/github-app-manifest-is-post-not-get.md`. The current `/manifest/launch` endpoint with POST form is correct; reverting is a regression.
- **Don't write the PEM contents into YAML** — `secretlint` will block the commit, and the architecture explicitly keeps PEM file paths in YAML but PEM contents env-only / on-disk.

## Operational state to confirm with the user

- Did `pnpm start:backend` (or whichever start command) get re-run after the scheduler fix?
- Did the API server log `SyncScheduler attached to ConnectorRegistry` on the new boot?
- After clicking "Sync now" in the drawer, did the Runs tab populate?
- If the run failed, what was the error message in the Runs tab?

That gives you ground truth before you start any new work.

## Status field

`active` while the user is mid-test. When the next agent confirms the first sync works end-to-end (or the user moves on to a different focus), update this to `completed` and move the file to `docs/agent/archive/`. Don't leave stale `status/` entries — that's the #1 anti-pattern called out in the ship-agent-context skill.
