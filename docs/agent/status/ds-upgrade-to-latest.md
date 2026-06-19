---
type: status
status: active
created: 2026-06-18
updated: 2026-06-18
author: claude-session-2026-06-18-ds-upgrade
branch: next-release
agent: claude-session-2026-06-18-ds-upgrade
tags: [web-ui, design-system, tokens, upgrade, theming]
---

# Design-system upgrade to latest — implemented, uncommitted

Bumped all seven `@ship-it-ui/*` packages in `packages/web-ui` to the current
public-npm releases and re-synced the local theme bridge. Prep step before
authoring the DS-repo prompt for the theming changes (the on-accent upstream +
others). NOT committed (standing rule: never commit/push without approval).

## Versions (all PATCH bumps, no breaking changes)

ui 0.0.16→**0.0.19**, tokens 0.0.7→**0.0.8**, shipit 0.0.17→**0.0.20**,
icons 0.0.12→**0.0.14**, cytoscape 0.0.16→**0.0.19**,
graph-editor 0.0.11→**0.0.14**, next 0.0.14→**0.0.17**.

## Changes landed (uncommitted, branch next-release)

- `packages/web-ui/package.json` — seven version bumps; `pnpm install` regenerated `pnpm-lock.yaml`.
- `packages/web-ui/src/components/connectors/connector-card.tsx` — `kind="connector"`
  → `kind="logo"` (the `connector` icon category is now a deprecated alias, removed at DS 1.0).
- `packages/web-ui/src/app/globals.css` — **full re-sync** of the local `@theme inline`
  bridge against the new `@ship-it-ui/ui/src/styles/globals.base.css`: added
  `accent-soft`/`accent-soft-text`, marketplace semantics (rating/verified/sale),
  display-font families, `display-lg`/`display-xl`, `spacing-px`, the full mobile
  token set (`spacing-touch/row/tabbar/navbar/screen`, `text-m-*`, `radius-m-*`),
  `color-scheme` light/dark in the base layer, and `accordion-up/-down` keyframes.

## Preserved divergence (do NOT regress)

The theme-aware `--color-on-accent` override (`:root` `#0a0a0b` / `[data-theme='light']`
`#ffffff`, bridged via `--color-on-accent: var(--color-on-accent)`) was **kept**.
The DS still ships only a hardcoded, theme-agnostic `--color-on-accent: #0a0a0b` in
`globals.base.css` — upstreaming a theme-aware token remains the open DS-repo task.
See [web-ui-theme-onaccent-and-settings-split](./web-ui-theme-onaccent-and-settings-split.md).
Display-font families are bridged but NOT loaded via CSS @import (would reintroduce
the Next font-URL-rebase break); they fall back to system fonts until a consumer
adds the `@fontsource` packages + JS imports like Geist.

## Verified (automated, all green)

`pnpm typecheck` clean; `pnpm lint` 0 errors (18 pre-existing warnings, none in
touched files); prettier clean on touched files; `pnpm test` 100/100; `pnpm build`
(next build) succeeds — the full Tailwind v4 `@theme`/`@source` stylesheet compiles
with every newly-bridged token.

## Regression found + fixed during visual pass (2026-06-18)

The full bridge re-sync introduced `--spacing-screen: var(--screen-pad)`, whose
key `screen` collides with Tailwind v4's reserved viewport keyword and emitted a
second `height: var(--screen-pad)` (16px) on `.h-screen`/`.min-h-screen`/`.w-screen`,
overriding `100vh`. The app shell (`flex h-screen`) collapsed to 16px → blank box
under the header (the user's "large white box"). Fixed by NOT bridging
`--spacing-screen`/`--spacing-screen-lg` (app uses `h-screen`, not `p-screen`);
added a warning comment in globals.css. Verified: fresh `pnpm build` emits
`.h-screen{height:100vh}` (no override); live app renders correctly in BOTH dark
and light (shell 1064px, sidebar full height, content visible). See
[scar](../scars/tailwind-spacing-screen-key-shadows-h-screen.md). The DS's own
`globals.base.css` ships `--spacing-screen` too — flag for the upstream DS prompt.

## Not yet done

- Deeper visual eyeball of accent-filled buttons/Banner contrast on a page that
  exercises them (Home is mostly outline buttons) — optional.
- Commit/push — awaiting user approval.

## Related

- [web-ui-theme-onaccent-and-settings-split](./web-ui-theme-onaccent-and-settings-split.md)
