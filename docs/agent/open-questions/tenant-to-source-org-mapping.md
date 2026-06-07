---
type: open-question
status: active
created: 2026-06-01
updated: 2026-06-01
author: claude-opus-4-7
tags: [auth, multi-tenant, neo4j, rbac]
opened: 2026-06-01
answer-source: maintainer
importance: standard
---

# How does `RequestContext.org` map to the `_source_org` property on nodes?

## Context

Milestone 1 (auth-and-rbac branch) threaded `RequestContext { user, org,
capabilities }` through every read method on `Neo4jService`. The intent
was that Stage B6 would add a Cypher `WHERE n._source_org STARTS WITH
$orgPrefix` predicate so the filter is in place the moment a second
tenant appears.

The seam is plumbed; the predicate isn't. The hold-up: `ctx.org` today
is the tenant id (single value, hard-coded `default`), while
`_source_org` on nodes is the _upstream_ origin per connector instance
— things like `github/shipitops` or `github/ship-it-ops`. A single
tenant routinely owns multiple `_source_org` values (their dev org,
their prod org). There's no mapping table that says "tenant default
owns these source_org prefixes."

A literal `STARTS WITH 'default'` predicate would match nothing.
Inverting it (allow every source_org for the `default` tenant) is
correct today but doesn't generalize.

## What we need an answer to

1. Should the mapping live in YAML (e.g.
   `accessControl.tenants: [{ id, sourceOrgPrefixes: [...] }]`) or be
   derived from the connector instances each tenant owns?
2. Single-tenant deployments — keep `default` as the implicit tenant
   that owns every connector, or require the operator to declare it
   explicitly?
3. Does the SaaS plan
   (`docs/agent/plans/saas-tier-shared-github-app.md`) want to use a
   different shape (per-tenant Redis prefix, separate Neo4j databases,
   row-level Cypher predicate)?

## Workaround

The `RequestContext.org` parameter is accepted-but-unused inside
`Neo4jService` read methods. No filter runs today. Multi-tenant
deployments are not supported.

## Related

- [canonical-id-org-namespacing](../decisions/canonical-id-org-namespacing.md)
  — embeds org in canonical IDs but doesn't define tenant
- `docs/agent/plans/saas-tier-shared-github-app.md` — the SaaS plan
  whose data partitioning this question feeds into
