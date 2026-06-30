---
type: investigation
status: fixed
created: 2026-06-24
updated: 2026-06-24
author: claude-session-2026-06-24-webhook-settings-ux
tags: [webhooks, settings, web-ui, api-server, ux, config]
importance: standard
---

# Admin → GitHub Webhooks: blank Receiver URL + "Set up" reports success before anything works

## Symptoms

In the deployed portal's **Admin Settings → GitHub Webhooks** tab:

1. The **Receiver URL** field was blank — admins were told to "paste this Payload URL"
   but there was nothing to copy.
2. Clicking **Set up** then closing the secret dialog flipped the connector row to a
   green **"Secret configured"** badge, even though the admin never pasted the secret
   into GitHub and no delivery had been verified — "the UI updates as if everything is
   configured without verifying anything works and without me doing anything."

## Root Cause

1. **Blank URL:** `SettingsService.getWebhookUrl()` returned
   `this.globalApp.webhookPublicUrl ?? ''`. In a deployed instance the committed
   `shipit.config.yaml` sets `webhookPublicUrl: ${GITHUB_WEBHOOK_PUBLIC_URL:-}`; with the
   env var unset the `:-` fallback resolves to the **empty string** (the schema's localhost
   default never fires because the key is present in YAML). `?? ''` only catches `undefined`,
   so the empty string passed straight through. Nothing derived the URL from the request,
   even though `manifestUrlsFromRequest` (`routes/connectors.ts`) already builds
   `${proto}://${host}/...` from forwarded headers for the redirect URL.
2. **Misleading "Set up":** the button immediately POSTed `/webhooks/:id/setup`, which
   **mints AND persists** a real secret server-side. So after a single click + close, the row
   genuinely became `secretConfigured: true`. The only positive badge ("Secret configured",
   green) conflated _"the portal stored a secret"_ with _"webhooks actually work."_ The true
   health signal — `lastVerifiedDelivery` — was ignored by the badge.

## Fix

- **URL fallback (backend):** effective URL precedence is now configured `webhookPublicUrl`
  (non-empty) → request-derived `${proto}://${host}/api/webhooks/github` → `''`. Added
  `SettingsService.effectiveWebhookUrl()` (empty-string-aware, not `??`), threaded a
  request-derived fallback from `routes/portal-settings.ts` (`receiverUrlFromRequest`) into
  `getWebhookUrl()` and `setConnectorWebhookSecret()` (so the pasted steps show the real URL).
- **Confirm-before-mint (UI):** the Set up / Rotate button now opens a confirm dialog; the
  POST fires only from the confirm's primary button, so opening + dismissing is a true no-op
  (reuses the `access-tab.tsx` confirm idiom). Rotate's copy flags it as destructive.
- **Honest tri-state status (UI):** derived from the existing `secretConfigured` +
  `lastVerifiedDelivery` — **Not set up** (neutral) / **Awaiting first delivery** (warn/amber,
  "Secret saved — paste it into GitHub to activate") / **Active** (green, only after a verified
  delivery). The reveal dialog now states the secret is already saved and webhooks stay
  inactive until pasted + verified. No backend change for the badge.

## Prevention

- A config value that is "present but empty" is NOT the same as "absent"; a Zod `.default()`
  only fills absent keys, so `?? ''` after a `:-` YAML fallback is a silent-empty trap. Prefer
  an explicit non-empty check + a request-derived fallback for any public-URL field.
- A persisted-secret flag is a "we stored something" signal, never a "the integration works"
  signal. Reserve the green/success state for an end-to-end verified event
  (`lastVerifiedDelivery`), not for a write the portal itself just made.

## Files

- `packages/api-server/src/services/settings-service.ts`
- `packages/api-server/src/routes/portal-settings.ts`
- `packages/web-ui/src/components/settings/webhooks-tab.tsx`
- Tests: `__tests__/services/settings-service.test.ts`,
  `__tests__/routes/portal-settings.test.ts`, `settings/webhooks-tab.test.tsx`

## Related

- [webhook-receiver-design](../decisions/webhook-receiver-design.md) — the receiver this manages
- [admin-portal-settings](../plans/admin-portal-settings.md) — the settings hub (#76) this fixes
