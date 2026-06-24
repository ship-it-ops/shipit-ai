---
type: status
status: completed
created: 2026-06-18
updated: 2026-06-18
author: claude-session-2026-06-18-portal-settings
branch: next-release
agent: claude-session-2026-06-18-portal-settings
tags: [web-ui, theme, design-system, tokens, settings, follow-up]
---

# web-ui: theme-aware on-accent + admin/user settings split (+ DS upstream follow-up)

## Done (committed + pushed, 015d98b)

1. **Light-theme button contrast fix.** `--color-on-accent` in
   `packages/web-ui/src/app/globals.css` was a hardcoded `#0a0a0b` literal
   inlined into the `text-on-accent` utility (so colored buttons/badges kept
   near-black text in every theme — illegible on the light theme's dark accent).
   Now theme-aware: `#0a0a0b` in dark (`:root`, bright accent), `#ffffff` in
   `[data-theme='light']` (dark accent).
2. **Admin vs user settings split.** New admin-only page
   `app/(app)/admin/settings/page.tsx` (sidebar Admin group) holds ONLY admin
   items — GitHub Webhooks, Login & Access, **Instance** (OIDC + config export,
   which is also admin, so it moved here). `app/(app)/settings/page.tsx` reverted
   to user prefs (Appearance, Notifications, API Keys). Sidebar entry repointed
   to `/admin/settings`; breadcrumb + page-level admin gate + test added.

## FOLLOW-UP — DONE: theme-aware `--color-on-accent` upstreamed to the DS

RESOLVED 2026-06-19. The DS shipped the theme-aware `--color-on-accent` token in
`@ship-it-ui/tokens@0.0.9` (`#0a0a0b` dark / `#ffffff` light, in `tokens.css`),
via the handoff prompt. On the DS bump to ui 0.0.20 / tokens 0.0.9, this app
**dropped the local `--color-on-accent` override** — globals.css now carries no
DS divergence for on-accent. See [ds-upgrade-to-latest](./ds-upgrade-to-latest.md).

## Architectural context for future agents (web-ui theming)

- `packages/web-ui/src/app/globals.css` **re-declares the DS theme bridge
  locally** (the `@theme inline` block + base layer) on purpose — a documented
  workaround because the DS's own `globals.css` imports Geist in a way Next's
  PostCSS chain can't URL-rebase. Keep it in sync with the DS if upstream tokens
  change.
- The DS Button uses the `text-on-accent` utility for primary/destructive/success
  (`bg-accent|bg-err|bg-ok text-on-accent`). The DS ships `--color-accent` and
  `--color-accent-text` (both theme-aware) but **no `--color-on-accent`** — the
  app owns it.
- Theme switch is via the `[data-theme='light']` attribute (default `:root` is
  dark). Light accent = `oklch(0.45 …)` (dark teal); dark accent = `oklch(0.82 …)`
  (bright).

## Related

- [admin-portal-settings](../plans/admin-portal-settings.md)
- [portal-settings-impl](./portal-settings-impl.md)
