---
type: open-question
status: active
created: 2026-05-20
updated: 2026-05-20
author: claude-opus-4-7
tags: [github, identity, canonical-id, breaking-change]
opened: 2026-05-20
answer-source: maintainer
importance: core
---

# Should `Repository` canonical IDs include the org namespace before multi-org orgs collide?

## Context

Today `Repository` canonical IDs are `shipit://repository/default/<name>` (`packages/connectors/github/src/normalizers/repository.ts`). The `default` segment is the canonical namespace; the org is not in the path.

Now that v1 supports multiple GitHub orgs ([github-connector-architecture-v1](../decisions/github-connector-architecture-v1.md)), two orgs with a repo of the same name (`acme/payments-api` and `contoso/payments-api`) will collapse to the **same** canonical ID and the core writer will treat them as one entity. Most multi-org setups will hit this — common repo names like `infra`, `web`, `api`, `docs` collide constantly.

The fix is straightforward: change the ID format to include org, e.g. `shipit://repository/default/<org>/<name>`. The plan called this out as the only breaking change in v1.

## Tried

- Read `packages/connectors/github/src/normalizers/repository.ts` — `buildCanonicalId('Repository', 'default', repo.name)`. One-line change to include the org.
- The linking-key format already includes org (`github://<org>/<repo>`), so identity-reconciliation downstream of the connector isn't affected — only the canonical ID. Existing graphs would need a migration or an aliasing pass during the linking-key → canonical-id resolution.

## Why It Matters Now vs. Later

- **If we ship v1 to anyone who connects two orgs** with overlapping repo names, data corruption is silent and immediate: PropertyClaims from both orgs collapse on the same `Repository` node.
- **If we wait**, every existing graph also needs migration, doubling the rollout effort.

## Open Decisions

1. **Format**: `shipit://repository/default/<org>/<name>` (org as extra segment) vs `shipit://repository/<org>/<name>` (org replaces `default` namespace).
2. **Migration**: forward-only (regenerate next sync) vs explicit migration script vs alias layer in the resolver for one release.
3. **Apply to other multi-tenant-relevant types** (`Team`, `Pipeline`, `Person`) at the same time?

## Who Can Answer

Maintainer / Mohamed — this is a data-model call with cross-cutting implications (MCP tool outputs reference canonical IDs verbatim; any external integration that stored shipit URIs will need to adapt).

## Related

- [github-connector-architecture-v1](../decisions/github-connector-architecture-v1.md)
