---
type: status
status: active
created: 2026-09-30
updated: 2026-09-30
author: claude-session-2026-09-30
branch: k8s-connector-fixes
agent: claude-session-2026-09-30
tags: [connectors, kubernetes, web-ui, wizard, portal-demo]
---

# Kubernetes connector fixes found while walking the wizard on portal-demo

The user is exercising the Connector Hub Kubernetes wizard (#115) against the live
`shipit-demo` cluster for the first time — every earlier test mocked the hooks. Items are
collected here as they surface; this branch accumulates them into one PR.

## Scope

- `packages/web-ui/src/components/connectors/add-kubernetes-connector-wizard.tsx` (+ test)
- anything else the walk-through turns up (api-server routes, connector, docs)

## Items so far

1. **Access-mode card had no visible selected state** (border-strong vs border was
   indistinguishable in the dark theme; only the focus ring hinted). Now mirrors the GitHub
   wizard's option cards: accent border + `bg-accent-dim/40` + radio dot, `data-selected` hook.
2. **Connect step had no success signal** — a good probe rendered as bare paragraphs
   ("Cluster version …", "Deployment: ok"). Now a `Banner tone="ok"` ("Connected to cluster
   _name_ running Kubernetes _version_. N namespaces in scope." + namespace chips) and a
   dot-and-word per-kind list (`readable` / `denied` / `error` / `skipped`). Parity with the
   GitHub wizard, which already had "Connected to _org_" in an ok banner. The first real probe
   against `shipit-demo` returned correct data (v1.35.6-gke.1250000, 9 namespaces, 4× ok).

3. **Display name was only a placeholder.** The Configure step showed the cluster name greyed
   out, so it read as set while the input was empty. Now a real prefilled value that follows
   the cluster name until the user edits it (`displayName: string | null`, null = untouched);
   an emptied field still falls back to the cluster name on submit.

4. **No initial sync after create.** `SyncScheduler.start()` only registers the BullMQ
   repeat job; nothing runs until the next cron tick. The GitHub wizard fires
   `triggerSync` right after create; the Kubernetes one did not, so the first live connector
   sat at "0 entities · Last sync: Never" (card "Syncing", drawer "degraded" — both are the
   `connectorInfo` "enabled, no runs yet" fallback, not a real state; see
   [connectorinfo-status-degraded-is-overloaded-as-syncing](../scars/connectorinfo-status-degraded-is-overloaded-as-syncing.md)).
   Now triggers the first sync + "Kubernetes connector created" toast, like GitHub.
5. **Card icon rendered "rn".** `DynamicIconGlyph kind="logo"` resolves `logo:<type>`; the DS
   (`@ship-it-ui/icons` 0.0.15) ships `logo:github` but only a plain `kubernetes` glyph, so
   the card drew the literal word as SVG text (clipped to "rn"). `connector-pill` had the same
   bug via `kind="connector"` (legacy alias of logo). New `lib/connector-type-icon.ts` picks
   logo-if-present-else-glyph; both call sites use it. **DS ask:** add `logo:kubernetes`.

6. **`degraded` overload removed.** `ConnectorInfo.status` gains `syncing` + `pending`;
   `CONNECTOR_STATUS` (`lib/connector-status.ts`) is the single label/dot/badge/pulse table and
   both the card and the drawer header use it. A genuinely partial sync now reads "Degraded" on
   the card instead of a pulsing "Syncing" forever. Scar updated with the new tripwire.

### Checked, not a bug

- Drawer showed schedule `0 * * * *` for a connector the wizard defaults to `*/5 * * * *` —
  the user had changed the field before submitting. Traced wizard → route → `registry.create`
  → Zod anyway; nothing rewrites it.

## Why

First real run of the wizard; portal-demo is on `sha-5f09af6` (deployed 2026-09-29), which
includes #115 + #116.

## Done when

Branch `k8s-connector-fixes` deleted on remote (the repo auto-deletes head branches on merge).
