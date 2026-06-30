---
type: investigation
status: fixed
created: 2026-06-25
updated: 2026-06-25
author: claude-session-2026-06-25
tags: [web-ui, connectors, naming, ui]
importance: standard
---

# Connector source pill rendered "GitHub · GitHub · ship-it-ops" (double type prefix)

## Symptoms

Entity detail page Summary → SOURCE pill showed `GitHub · GitHub · ship-it-ops`.
(Also the pill overflowed the card — separate CSS fix, see below.)

## Root Cause

A two-sided naming-contract mismatch on the connector `name` field:

- The add-connector wizard seeded `name` with the **fully composed** label
  `` `GitHub · ${org}` `` (`add-github-connector-wizard.tsx:266`).
- The render helper `resolveConnectorIdentity` treats `name` as a **bare
  instance name** and composes `` `${typeLabel} · ${name}` `` itself
  (`connector-identity.ts`). So a stored `GitHub · ship-it-ops` became
  `GitHub · GitHub · ship-it-ops`.

Canonical convention (per `ConnectorIdentity` docs, `connector-pill.tsx`,
`connector-card.tsx`): stored `name` = bare instance/org; the type prefix is
added at render time. The wizard was the outlier polluting stored data.

## Fix

1. `connector-identity.ts` — made composition idempotent via `stripTypePrefix()`
   (strips a leading `${typeLabel} · ` before composing). Fixes already-stored
   legacy/composed names with no data migration. Regression test added at
   `connector-identity.test.ts`.
2. `add-github-connector-wizard.tsx:266` — seed bare org (`probeResult.suggestedOrg`)
   instead of the composed label, so we stop storing redundant data.
3. Unrelated overflow: `connector-pill.tsx` (max-w-full/min-w-0 + truncated
   label span) + Summary `<dd>` got `min-w-0` so a long pill ellipsizes inside
   the card instead of spilling over. The Badge from `@ship-it-ui/ui` is
   `inline-flex whitespace-nowrap`.

## Prevention

The stored connector `name` is the BARE instance name. Never prepend the type
label before persisting; compose only at render time via
`resolveConnectorIdentity`. `stripTypePrefix` keeps render idempotent if this
slips again.

## Related

- [webhook-settings-empty-url-and-misleading-setup](webhook-settings-empty-url-and-misleading-setup.md)
