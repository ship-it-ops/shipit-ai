---
type: decision
status: active
created: 2026-06-25
updated: 2026-06-25
author: claude-session-2026-06-25
tags: [auth, multi-tenant, rbac, neo4j, access-model]
importance: core
---

# No tenant read-isolation — an authenticated user sees all orgs, connectors, and entities

## Context

The platform threads `RequestContext { user, org, capabilities }` through every
Neo4j read as a seam for a future per-tenant filter (Stage B6 was to add
`WHERE n._source_org STARTS WITH $orgPrefix`). The open question
[[tenant-to-source-org-mapping]] asked how `ctx.org` (tenant id, always
`default`) should map to nodes' `_source_org` (per-connector upstream origin,
e.g. `github/ship-it-ops`). The seam was plumbed but no predicate ever ran.

## Decision

The intended access model is: **if you are logged into the platform you can view
ALL orgs and their associated connectors and entities.** There is no per-tenant
read isolation. The current behavior — a single `default` principal seeing
everything — is correct _by design_, not a stopgap.

- The `ctx.org` / `_ctx` read seam in `Neo4jService` stays a permanent no-op.
- No tenant→`_source_org` mapping table is needed.
- "Viewing an org's data" is satisfied at **connector granularity**: a GitHub
  connector instance is scoped to exactly one org, so the source-connector pill
  (`GitHub · ship-it-ops`) + the catalog "source" facet already function as the
  per-org view. No separate org dimension/facet/overview page is being built
  (user chose "connector view is enough", 2026-06-25).

## Alternatives Considered

- **Per-tenant Cypher predicate (`_source_org` filter):** rejected — the product
  is single-shared-visibility for authenticated users; isolation isn't wanted.
- **Explicit org dimension in the UI (facet / orgs overview page):** rejected for
  now — connector = org, so it'd be redundant surface area.

## Consequences

- Multi-tenant _data isolation_ is explicitly out of scope until the access model
  changes. The seam can remain (cheap, documented) rather than be ripped out.
- `_source_org` stays provenance-only. The API exposes it as `sourceOrg`
  (`graph.ts`) but it is **dead/unconsumed** on the web-ui client — harmless;
  optional future cleanup, not required.

## Revisit Triggers

- A customer/contract requires tenant data isolation (true multi-tenant SaaS) —
  then the `ctx.org` seam gets a real predicate and this decision reopens.
- See [[saas-tier-shared-github-app]] — if that plan adopts hard tenant
  boundaries, reconcile with this decision first.

## Related

- [tenant-to-source-org-mapping](../open-questions/tenant-to-source-org-mapping.md) — the question this answers
- [connector-name-double-type-prefix](../investigations/connector-name-double-type-prefix.md) — the source-connector pill that doubles as the per-org view
