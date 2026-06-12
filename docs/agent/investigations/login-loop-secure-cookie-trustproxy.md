---
type: investigation
status: completed
created: 2026-06-12
updated: 2026-06-12
author: claude-session-2026-06-12
branch: fix-session-cookie-and-admin-emails
tags: [auth, session, cookie, trust-proxy, gke, ingress, deploy]
importance: core
---

# Login loop: Secure session cookie silently dropped behind TLS-terminating Ingress

## Symptom

After the redirect_uri and email-permission fixes, portal-demo sign-in
"flickered": clicking Continue with GitHub round-tripped through
github.com (auto-approved) and landed straight back on /login with no
error. Logs showed clean callbacks — exchange succeeded, no warnings —
but the browser never received `shipit_sid`, and notably no
/api/auth/me requests appeared (web-ui middleware bounces on cookie
absence without calling the API).

## Root cause

TLS terminates at the GKE Ingress; pods see plain HTTP. `@fastify/session`
silently skips Set-Cookie when `cookie.secure === true` and
`request.protocol !== 'https'` (fastifySession.js
`isInsecureConnection`), and secure is forced true in production.
`createServer` never set Fastify's `trustProxy`, so `X-Forwarded-Proto:
https` was ignored and every request read as http. Authenticated
callback → no cookie → middleware bounce → GitHub auto-approve → loop.
Completely silent: no server error, no client error.

## Fix (same branch)

- New `backend.api.trustProxy` config field (default false), passed to
  the Fastify constructor; `trustProxy: true` set in the deployed
  `shipit.config.yaml`. Side effect: rate limiting now keys real client
  IPs instead of the LB's single IP (latent shared-bucket bug).
- Regression tests run the full login→callback flow with prod cookie
  posture behind a simulated proxy — both the fix and the documented
  failure mode.

## Bundled: role/allow-list match ANY verified GitHub email

The wizard-captured admin email may not be the user's GitHub primary.
`GitHubUserInfo` gained `verifiedEmails` (provider now always queries
/user/emails, merging the public-profile email; 403 falls back to the
public email instead of failing); `resolveRole` /
`emailPassesAllowList` match against the full set. Identity
(`principal.email`) stays the resolved primary. The /user/emails 403
error now names the missing "Email addresses: Read-only" App permission.

## Scar to remember

When auth "succeeds but doesn't stick" behind any proxy: check
`trustProxy` before anything else. The session library's secure-cookie
skip produces zero diagnostics on either side.

## Related

- [first-login-redirect-uri-and-missing-callback-urls](first-login-redirect-uri-and-missing-callback-urls.md)
- [setup-mode-first-boot](../decisions/setup-mode-first-boot.md)
