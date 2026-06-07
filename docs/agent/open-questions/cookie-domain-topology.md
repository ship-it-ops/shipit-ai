---
type: open-question
status: answered
created: 2026-06-04
updated: 2026-06-04
author: claude-session-2026-06-04-deployment
opened: 2026-06-04
answer-source: maintainer
tags: [auth, cookies, deployment, vercel, fly, cors, embedded]
---

# How do the Vercel web-ui and Fly API share a first-party session cookie?

> **✅ ANSWERED / MOOT (2026-06-04).** The Vercel + Fly split was abandoned (see
> decision [hosting-gke-distributed-not-vercel](../decisions/hosting-gke-distributed-not-vercel.md)).
> On GKE, a **single-origin Ingress** serves `/` (web-ui) and `/api` (api-server)
> from one host, so the session cookie is first-party (`SameSite=Lax`) and the
> Redis session store is kept as-is. No cross-domain cookie work needed. Retained
> for the analysis below in case a split-origin topology is ever reconsidered.

## Context

In `embedded` deployment mode (see plan `deployment-runtime-modes`), auth is ON
and sessions are a **stateless encrypted cookie**. But the planned topology puts
the web-ui on Vercel and the api-server on Fly. If those are on different
registrable domains (e.g. `something.vercel.app` and `something.fly.dev`), the
browser treats the session cookie as a **third-party cookie** — which Safari
(ITP), Firefox, and Chrome's third-party-cookie restrictions increasingly block.
Result: login silently fails for many users, **regardless of the session storage
mechanism**. This is a topology problem, not a storage problem.

Today's code already does credentialed cross-origin (`@fastify/cors` with
`credentials: true` + `accessControl.web.allowedOrigins`, and a config-driven
`sameSite`), and a recent commit added `Access-Control-Allow-Credentials` even in
disabled-auth mode — so cross-origin is already in play and this needs a
deliberate answer.

## Options

1. **Shared subdomains on one custom domain (recommended).**
   `app.yourdomain.com` (Vercel) + `api.yourdomain.com` (Fly). Same registrable
   site → first-party `SameSite=Lax` cookie that works in all browsers.
   Cost: a custom domain (~$10/yr) attached to both Vercel and Fly.
2. **Vercel same-origin proxy.** Vercel rewrites keep the browser on the Vercel
   origin only; `/api/*` is proxied server-side to Fly. Cookie is first-party to
   the Vercel origin. No custom domain, but adds a proxy hop and rewrite config,
   and the API must be reachable from Vercel's network.
3. **Accept `*.vercel.app` + `*.fly.dev` with `SameSite=None; Secure`** — works
   only while third-party cookies are allowed; fragile and degrading. Not
   recommended; listed only to reject it.

## Decision

**Deferred to deployment-setup time** (user, 2026-06-04). Captured now so it
isn't forgotten — it MUST be resolved before the auth flow works end-to-end on a
real Vercel + Fly deploy. Leaning option 1 (shared subdomains) for robustness;
option 2 if avoiding a custom domain matters more than the proxy hop.

## Who Can Answer

Maintainer (user) — at deploy time, based on whether a custom domain is
acceptable.

## Related

- [deployment-runtime-modes](../plans/deployment-runtime-modes.md) — embedded auth design that this unblocks
