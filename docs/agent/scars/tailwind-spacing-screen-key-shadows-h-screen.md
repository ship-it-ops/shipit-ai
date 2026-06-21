---
type: scar
status: active
created: 2026-06-18
updated: 2026-06-18
author: claude-session-2026-06-18-ds-upgrade
incident-date: 2026-06-18
tripwire: 'if the app shell (flex h-screen) collapses to ~16px / content area is a blank box under the header, check globals.css @theme inline for a `--spacing-screen` (or any spacing key named after a reserved Tailwind sizing keyword) shadowing h-screen'
tags: [web-ui, tailwind, design-system, tokens, theming, css]
---

# A `--spacing-screen` theme key silently overrides Tailwind's `h-screen` (100vh → 16px)

## What Happened

During the `@ship-it-ui/*` DS upgrade, the local Tailwind v4 theme bridge in
`packages/web-ui/src/app/globals.css` was "fully re-synced" against the DS's
`globals.base.css`. That sync added the DS mobile-spacing tokens, including
`--spacing-screen: var(--screen-pad)`. In Tailwind v4, `@theme` entries under the
`--spacing-*` namespace mint sizing utilities for that key — and the key `screen`
**collides with Tailwind's reserved viewport keyword**. Tailwind then emitted:

```css
.h-screen {
  height: 100vh;
  height: var(--screen-pad);
} /* --screen-pad = 16px wins */
```

So `h-screen` / `min-h-screen` / `w-screen` resolved to 16px. The app shell
(`flex h-screen overflow-hidden`) collapsed to 16px, `html`/`body` shrink-wrapped
to 16px, the sidebar (`h-full`) collapsed to 28px, and the entire content area
rendered as a single blank box under the top header — white in light theme
("large white box cutting out everything except the top sliver"), near-black in dark.

## Tripwire

App shell `flex h-screen` collapses to ~16px / content area is a blank box below
the header → grep `globals.css` for `--spacing-screen` (or any `--spacing-<key>`
whose key is a reserved Tailwind sizing word: `screen`, `full`, `min`, `max`,
`fit`, `auto`, `px`) shadowing the viewport utilities.

## Why It Hurt

Whole app looked broken after a "green" upgrade. It slipped through every gate:
`next build` happily emits the valid-but-wrong CSS; vitest runs with `css: false`;
eslint/prettier don't evaluate CSS semantics; and a `grep h-screen` over the built
CSS shows the selector PRESENT (the bug is the second `height` declaration, not a
missing rule). A red herring (browser serving a stale partial 215-rule dev CSS)
masked it further — the real proof was reading the generated `.h-screen` _rule body_.

## Don't Do This

- Do NOT bridge `--spacing-screen` / `--spacing-screen-lg` (or any spacing key
  named after a reserved Tailwind sizing keyword) into the `@theme inline` block.
  The DS's own `globals.base.css` ships `--spacing-screen` — carrying the same
  footgun for any consumer that uses `h-screen`. Flag it for the upstream DS fix.
- When verifying CSS/utility changes, don't stop at "selector present in built CSS"
  or at `next build` success — read the generated rule body, or check computed
  layout in a browser (both themes). CSS regressions are invisible to typecheck/
  unit tests here.

## Related

- [ds-upgrade-to-latest](../status/ds-upgrade-to-latest.md) — the upgrade this surfaced in
- [web-ui-theme-onaccent-and-settings-split](../status/web-ui-theme-onaccent-and-settings-split.md) — the globals.css local-bridge mirror
