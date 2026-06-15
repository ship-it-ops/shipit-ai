---
type: investigation
status: completed
importance: core
created: 2026-06-15
updated: 2026-06-15
author: claude-session-2026-06-15
branch: more-prod-fixes
tags: [web-ui, connectors, github, wizard, manifest, ux]
---

# Per-org GitHub App created but the wizard looked untouched

## Symptom

User completed the per-org "Create App on GitHub" manifest flow, clicked
"Return to ShipIt-AI", and the wizard looked exactly like its initial
empty state — "as if I had not created it". Reproduced twice on
portal-demo.

## Root cause (confirmed by prod logs + user screenshot — NOT a data bug)

The whole pipeline actually WORKED. From the api-server logs of the
user's retry (nonce `0fd2fcb2…`):

- `manifest/launch …nonce=0fd2fcb2` → 200
- `pending-instance/0fd2fcb2` polled every 2s → 404 (not stashed yet)
- `app-manifest-callback?code=…&state=724f0aec…` → **200** (1.18s; App
  created + creds persisted). NB `state` ≠ `nonce` is BY DESIGN —
  `issueState`/`consumeState` map the opaque CSRF `state` back to the
  wizard nonce server-side (in-memory in the manifest service).
- next `pending-instance/0fd2fcb2` → **200** (wizard claimed the creds)
- after "Return": `/api/connectors` + `/api/connectors/github/app` (200)
  — wizard re-opened; NO re-poll → restore applied `claimed` from
  localStorage directly.

So the App was created, credentials claimed, and re-attached in the
returning tab. The bug was purely **presentation**: on a successful
claim, `apply()` writes the creds into `overrideAppId`/`overrideKeyPath`
and flips `perOrgPending` false. Those fields render only inside the
COLLAPSED `<details>` "I already have an App — paste credentials
manually" section, and the button reverts to the default "Create App on
GitHub". The only success signal was a transient toast. Net: the card
looked untouched even though `appStepValid` was already true (Next was
enabled) — the user just had no visible confirmation. User confirmed via
screenshot: App ID 4062823 + key path were present, dumped into the
manual-paste section.

## Fix (committed to branch `more-prod-fixes`, uncommitted in git)

`packages/web-ui/src/components/connectors/add-github-connector-wizard.tsx`:

- New `perOrgCreatedApp` state `{appId, appName, keyPath} | null`.
- Set it in BOTH credential-arrival paths: the poll's `apply()` and the
  cross-tab restore `claimed` branch. Cleared in `reset()`.
- The per-org "Create the App in this org" card now renders a prominent
  `<Banner tone="ok">` — `App "<name>" created and attached … click Next`
  with the App ID + key path — INSTEAD of the create form, plus a
  "Create a different App" link (`discardPerOrgCreatedApp`) to start over.

Test: new `add-github-connector-wizard.test.tsx` seeds the localStorage
resume record with a `claimed` App, renders the wizard open, and asserts
the visible "created and attached" confirmation (was: hidden in the
collapsed details). Full web-ui suite 88 passing; typecheck + lint clean.

## Note

Deployed demo won't show this until committed → merged to main →
`build-images.yml` + `deploy.yml` at the new SHA (deploys are manual; see
memory demo-deploy-pipeline). Relates to
[github-auth-connector-separation](../status/github-auth-connector-separation.md)
(the original per-org claim/resume work this polishes).
