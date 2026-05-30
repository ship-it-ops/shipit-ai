---
type: scar
status: active
created: 2026-05-30
updated: 2026-05-30
author: claude-opus-4-7
tags: [web-ui, connectors, status, ux]
importance: core
incident-date: 2026-05-30
tripwire: "if you render ConnectorInfo.status as raw text, you will show 'degraded' during a normal in-flight sync"
---

# `ConnectorInfo.status === 'degraded'` is overloaded — it also means "syncing"

## What Happened

User hit "Sync now" on a healthy GitHub connector. The drawer header immediately
rendered two badges side-by-side: `degraded` and `🌀 syncing`. The connector
was not actually degraded — it was a normal in-flight sync.

## Tripwire

`connectorInfo()` in `packages/web-ui/src/lib/api.ts` deliberately returns
`status: 'degraded'` when `runtime.state === 'running'` (see the comment at
line 109-111: "Maps to the DS `syncing` chip via the card's statusMap"). The
overload only works because the card has a translation table
(`statusLabel`/`statusDotState` in `connector-card.tsx`) that turns
`'degraded'` into the user-facing word "Syncing".

**Any new surface that prints `info.status` as raw text will leak the word
"degraded" during normal syncs.**

## Why It Hurt

User-facing: a freshly-triggered sync appeared broken at a glance — the badge
they actually wanted to see ("syncing") was buried next to a scary warning
chip ("degraded"). On the Connector Hub grid the card looked correct, so the
inconsistency was disorienting (drawer says one thing, card says another).

## Don't Do This

Do **not** write `<Badge>{info.status}</Badge>` (or similar) in any new
component. Either:

1. Suppress the status badge when `runtime?.state === 'running'` and let the
   dedicated "syncing" badge stand alone (what the drawer's `HeaderRow` now
   does).
2. Translate via a label map that mirrors `connector-card.tsx`'s
   `statusLabel`/`statusDotState` so `'degraded'` renders as "Syncing" while
   running.

Longer-term cleanup worth considering: rename the overload — give
`ConnectorInfo` a real `'syncing'` status variant so the literal value matches
the intent. Until that lands, treat the `'degraded'`-means-syncing rule as
load-bearing.

## Related

- [github-connector-architecture-v1](../decisions/github-connector-architecture-v1.md)
