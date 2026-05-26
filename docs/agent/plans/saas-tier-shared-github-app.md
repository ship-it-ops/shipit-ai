---
type: plan
status: active
created: 2026-05-21
updated: 2026-05-21
author: claude-opus-4-7
tags: [saas, github, app-manifest, future]
importance: standard
---

# Future: hosted SaaS tier with a shared, ship-it-ops-owned GitHub App

## Goal

If/when ShipIt-AI offers a hosted SaaS tier (ship-it-ops runs the infrastructure, customers don't), the App-ownership model can flip: ship-it-ops owns a single GitHub App (potentially Marketplace-listed), customers install it into their orgs, and ship-it-ops mints installation tokens server-side. No private-key distribution to customer machines because there are no customer machines.

This is **deferred**, not rejected. Self-hosted is the current product shape and the manifest-flow approach (see [github-app-manifest-flow](../decisions/github-app-manifest-flow.md) once written) covers it well. Capturing the SaaS path so the next agent thinking about packaging / distribution doesn't have to re-derive it.

## Approach (sketch)

**Prereqs that would need to land before this is worth doing:**

- Real auth (replace the dev-user identity stub).
- Multi-tenancy in Neo4j / event-bus (today the app assumes one customer's data).
- Billing.

**Then:**

1. **Create the App on `ship-it-ops`'s org**, set "Where can it be installed?" → Any account.
2. **Publish in GitHub Marketplace** (optional but discoverable) — paid or free listing.
3. **Customer install flow**: customer clicks "Install" from Marketplace or our website, picks their org, selects repos. GitHub posts to ship-it-ops' Marketplace webhook with the installation ID + customer info.
4. **ship-it-ops backend**: stores `{customer_id, installation_id}`, mints installation tokens server-side using the _single_ App private key (held only in production secrets infra).
5. **Webhook URL**: one ingress (ship-it-ops). Demuxes by installation ID to the correct customer's data partition.
6. **Customer-facing UI**: the wizard's "Connect GitHub" step changes — they click "Install ShipIt-AI on GitHub", complete the install on GitHub's side, and come back to a connector already wired up.

## Trade-offs vs. self-hosted

|                                | Self-hosted (today)                                  | SaaS (this plan)                                   |
| ------------------------------ | ---------------------------------------------------- | -------------------------------------------------- |
| Key custody                    | Customer's machine                                   | ship-it-ops production secrets                     |
| Setup steps                    | Manifest-flow wizard (still ~5 clicks on GitHub)     | One Install button                                 |
| Per-customer rate limit        | 5k/hr per installation                               | 5k/hr per installation (unchanged)                 |
| Webhook URL                    | Per-customer (smee in dev, customer ingress in prod) | One — ship-it-ops ingress                          |
| Trust model                    | Customer trusts their own infra                      | Customer trusts ship-it-ops                        |
| Customer can audit token usage | Yes (their App)                                      | Limited (ship-it-ops App acts on their behalf)     |
| Suspends/revocations           | Per-customer                                         | Affects all customers if the shared App is revoked |

## Files to Touch (when activated)

- New backend repo or service tier for the hosted control plane.
- `packages/api-server/src/routes/marketplace-webhook.ts` — handle Marketplace install/uninstall events.
- Tenant-aware data layer changes.
- `connectors.github.app` config gains a `mode: 'self-hosted' | 'saas'` discriminator so existing self-hosted users keep working unchanged.

## Status

Not started, not committed. Captured here because the user mentioned wanting it eventually so a future agent doesn't have to re-litigate "wait, didn't we want SaaS?".

## Revisit Triggers

- Real auth lands.
- A paying customer asks for hosted.
- Three customers in a row hit the same self-hosted setup friction we couldn't solve via docs.

## Related

- [github-connector-architecture-v1](../decisions/github-connector-architecture-v1.md) — point 5 (secrets model) is what flips in the SaaS world
- [per-org-github-app-override](../decisions/per-org-github-app-override.md) — self-hosted's answer to per-tenant isolation; SaaS solves the same problem differently
