---
type: plan
status: completed
created: 2026-06-18
updated: 2026-06-19
author: claude-session-2026-06-18-ds-upgrade
tags: [design-system, tokens, theming, handoff, ship-it-design]
---

# Handoff prompt for the `ship-it-ops/ship-it-design` repo

This file is the **prompt to paste into a session working in the DS repo**
(`/Users/mohamede/Repos/Ship-It-Ops/ship-it-design/`). It requests two theming
fixes surfaced by the downstream consumer ShipIt-AI during a DS upgrade. Everything
below the line is the prompt; the paths/snippets were verified against the DS source.

After these land + publish, ShipIt-AI drops its two local divergences (the
theme-aware on-accent override and the omitted `--spacing-screen` bridge) on its
next DS bump. See [ds-upgrade-to-latest](../status/ds-upgrade-to-latest.md) and
[scar](../scars/tailwind-spacing-screen-key-shadows-h-screen.md).

---

## PROMPT — paste into a ship-it-design session

You are working in the `@ship-it-ui` design-system monorepo (`ship-it-ops/ship-it-design`,
pnpm + turbo + changesets). Make two related theming fixes. Both were found by a
downstream consumer (ShipIt-AI) that maintains a local copy of the DS Tailwind v4
theme bridge and hit real bugs. **First `git checkout main && git pull` so you're on
the latest release**, then create a feature branch.

### Background

- Tokens live in `@ship-it-ui/tokens`. `packages/tokens/styles/tokens.css` is
  **auto-generated** from TS source by `pnpm --filter @ship-it-ui/tokens build`
  (`tsup && tsx scripts/build-css.ts`); the emitter is `packages/tokens/src/emit-css.ts`,
  which kebab-cases every key in `colorSemanticDark` / `colorSemanticLight`
  (`packages/tokens/src/color.ts`) into `:root` and `[data-theme='light']`. Adding
  a key to BOTH objects auto-flows into `tokens.css` (the two objects are kept in
  lockstep by a `satisfies` constraint — a missing key is a compile error).
- The Tailwind v4 `@theme inline` token→utility bridge lives in `@ship-it-ui/ui` at
  `packages/ui/src/styles/globals.base.css`. A CSS var only becomes a utility if it
  has a bridge line here.
- There is a CSS snapshot test: `packages/tokens/scripts/build-css.test.ts`
  (`toMatchSnapshot()` over the generated `tokens.css`, plus `toContain` asserts).
  Any token change updates the snapshot — accept with `pnpm --filter @ship-it-ui/tokens test -- -u`.
- CI order (per CONTRIBUTING): format → lint → typecheck → test → build. Run
  `pnpm changeset` for any published-package change.

---

### Change 1 — make `--color-on-accent` theme-aware (currently hardcoded near-black)

**Problem.** `--color-on-accent` is the foreground for components sitting on an
accent surface (`text-on-accent` / `bg-on-accent` — primary/destructive/success
Buttons, solid Badges, Switch, Checkbox, Sidebar/NavBar/Calendar/Stepper/TabBar
active states, MapMarker, CopilotMessage). It is defined ONLY as a hardcoded literal
in `packages/ui/src/styles/globals.base.css:52`:

```css
/* Always near-black, regardless of theme. */
--color-on-accent: #0a0a0b;
```

In the **light** theme `--color-accent` is a DARK teal (`oklch(0.45 …)`), so a
primary button (`bg-accent text-on-accent`) renders near-black text on a dark
accent — illegible (fails contrast). In **dark** theme accent is bright
(`oklch(0.82 …)`), so near-black is correct. The token must be theme-aware.

**Fix.** Move `on-accent` into the token source as a theme-aware semantic color
(dark = near-black, light = white), mirroring how `accentText`/`accentSoftText` are
done, then bridge the utility to the token instead of the literal.

1. In `packages/tokens/src/color.ts`, add an `onAccent` key to BOTH theme objects,
   right after the accent group:
   - `colorSemanticDark` (near line 58, after `accentSoftText`):
     ```ts
     // Foreground for components on an accent surface (primary buttons, solid
     // badges). Dark theme accent is bright → near-black reads best.
     onAccent: '#0a0a0b',
     ```
   - `colorSemanticLight` (near line 115, after `accentSoftText`):
     ```ts
     // Light theme accent is dark → white reads best.
     onAccent: '#ffffff',
     ```
     This emits `--color-on-accent` into `:root` (#0a0a0b) and `[data-theme='light']`
     (#ffffff) on the next tokens build.

2. In `packages/ui/src/styles/globals.base.css:52`, change the hardcoded literal to
   reference the token (matching every other color in the block), and update the
   comment:
   ```css
   /* Foreground for components on an accent surface (primary buttons, solid
    * badges). Theme-aware: near-black in dark, white in light. */
   --color-on-accent: var(--color-on-accent);
   ```

**Notes / guardrails.**

- Values `#0a0a0b` (dark) / `#ffffff` (light) are the contrast-correct pair the
  downstream consumer already validated.
- Two existing call sites use `text-on-accent` over a NON-accent surface:
  `packages/ui/src/patterns/TabBar/TabBar.tsx:143` (`bg-err text-on-accent` badge)
  and `packages/map/src/MapMarker.tsx:24` (sale marker). Theme-aware on-accent does
  NOT regress them (white-on-err in light matches `--color-err-fg`; near-black-on-err
  in dark is readable). Optionally tidy these later to use the dedicated on-status fg
  tokens, but that is not required here.
- No component source changes are needed for the 14 consumers — they pick up the
  theme-aware value automatically through the utility.

---

### Change 2 — stop the `screen` spacing key from shadowing Tailwind's `h-screen`

**Problem (real downstream breakage).** `packages/ui/src/styles/globals.base.css:159-160`
register screen padding as spacing keys:

```css
--spacing-screen: var(--screen-pad);
--spacing-screen-lg: var(--screen-pad-lg);
```

In Tailwind v4 a `--spacing-<key>` entry mints the FULL sizing family for that key,
so `--spacing-screen` also generates `h-screen` / `min-h-screen` / `max-h-screen` /
`w-screen` — which **shadow Tailwind's built-in viewport utilities** (`100vh`/`100vw`),
silently redefining them to the 16px screen pad:

```css
.h-screen {
  height: 100vh;
  height: var(--screen-pad);
} /* 16px wins */
```

Any consumer using `h-screen` for a full-height app shell gets a layout collapsed to
16px. (This actually shipped a blank-screen bug downstream.)

**Fix.** Rename the spacing key so it no longer collides with the reserved `screen`
keyword. The underlying token var (`--screen-pad`, from `packages/tokens/src/mobile.ts`
`screenPad`/`screenPadLg`) stays unchanged — only the `@theme inline` bridge key and
its one internal consumer change.

1. `packages/ui/src/styles/globals.base.css:159-160` — rename `screen` → `gutter`
   (recommended; `page` is a fine alternative). Update the comment on line 151-152
   that mentions `p-screen`:
   ```css
   --spacing-gutter: var(--screen-pad);
   --spacing-gutter-lg: var(--screen-pad-lg);
   ```
2. `packages/ui/src/patterns/LargeTitle/LargeTitle.tsx:39` — the only DS consumer:
   change `px-screen` → `px-gutter`.

This RESTORES native `h-screen`/`w-screen` (100vh/100vw) for all downstream consumers
and keeps a screen-edge padding utility as `p-gutter`. No DS component uses the
broken `h-screen`/`min-h-screen`/`w-screen` form (verified — only `LargeTitle` uses
`px-screen`). The tokens.css and its snapshot test are unaffected (the var name
`--screen-pad` doesn't change).

> Note this is a (pre-1.0) utility rename: `p-screen` → `p-gutter`. Call it out in
> the changeset. There is no way to keep the `screen` key without the collision.

---

### Changeset + verification

Create changeset(s) with `pnpm changeset` (two files for a clean changelog, or one
combined — your call):

- Change 1: `@ship-it-ui/tokens: patch`, `@ship-it-ui/ui: patch` —
  "Make `--color-on-accent` theme-aware (near-black in dark, white in light) so
  `text-on-accent` is legible on the light theme's dark accent."
- Change 2: `@ship-it-ui/ui: patch` —
  "Rename the `screen` spacing key to `gutter` (`p-screen`→`p-gutter`) so it no
  longer shadows Tailwind's reserved `h-screen`/`w-screen` viewport utilities."

(`updateInternalDependencies: patch` will cascade bumps to `shipit`/`map`/etc.)

Verify, from the repo root:

1. `pnpm --filter @ship-it-ui/tokens build` — regenerates `tokens.css`; confirm
   `--color-on-accent` now appears in BOTH `:root` (#0a0a0b) and `[data-theme='light']`
   (#ffffff).
2. `pnpm --filter @ship-it-ui/tokens test -- -u` — update + review the CSS snapshot diff
   (should add only the two `--color-on-accent` lines).
3. `pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm build` (CI order).
4. In the generated/compiled `ui` CSS, confirm `.h-screen { height: 100vh }` with NO
   second `height: var(--screen-pad)` declaration, and that `.p-gutter` exists.
5. Update any affected Storybook stories in `apps/docs-site` (on-accent button/badge
   examples in light theme; any `LargeTitle`/`px-screen` story) and the relevant
   `*.stories.tsx`. Eyeball a primary Button + solid Badge in BOTH themes.

Out of scope: don't touch downstream apps; don't bump majors; keep changes additive
except the documented `p-screen`→`p-gutter` rename.
