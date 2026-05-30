---
type: decision
status: active
created: 2026-05-20
updated: 2026-05-30
author: claude-opus-4-7
tags: [github, identity, canonical-id, breaking-change]
importance: core
---

# Org-scope canonical IDs for GitHub-owned entities (Repository, Team, Pipeline)

## Context

Pre-change, `Repository`/`Team`/`Pipeline` canonical IDs were
`shipit://<label>/default/<name>` — the `default` segment is the canonical
_namespace_ (intended for environment-scoping; e.g. `LogicalService` uses
`'prod'` per `packages/shared/src/__tests__/canonical-id.test.ts`), and the
org was not in the ID.

V1 supports multiple GitHub orgs via the installation picker
([github-installation-picker](./github-installation-picker.md)). The moment a
user connected two orgs that shared a common repo name (`infra`, `api`,
`web`, `docs`...), `IdentityReconciler` collapsed claims from both orgs onto
a single node. The two-step reconcile-ladder didn't save us: linking keys
were already org-scoped (`github://<org>/<repo>`), but the _primary-key_
check (`linkingKeyIndex.hasCanonicalId(node.id)`) hit on the colliding
canonical ID first and merged silently. See
`packages/core-writer/src/identity/reconciler.ts`.

Originally raised as an open question on 2026-05-20; decided + shipped
2026-05-30 (this note replaces
`docs/agent/open-questions/canonical-id-org-namespacing.md`).

## Decision

### Format

Extra segment within the `default` namespace:

```
shipit://repository/default/<org>/<name>
shipit://team/default/<org>/<slug>
shipit://pipeline/default/<org>/<repo>-<workflow>
shipit://person/default/<login>          # unchanged — global
```

The existing `CANONICAL_ID_REGEX` in `packages/shared/src/identity/canonical-id.ts`
already permits slashes in the final group; no regex change needed.
`parseCanonicalId` returns the slashed string as `name`.

### Scope

- **Org-scoped**: `Repository`, `Team`, `Pipeline` — all are owned by a
  GitHub org on the source side.
- **Global**: `Person` — a GitHub login is globally unique across orgs.
  Two orgs each invite `@alice` and they refer to the _same_ user.
- **Codeowner edges**: team owners parsed from `@<org>/<team>` syntax
  preserve the explicit org (fixed a latent bug where
  `@acme-corp/platform` referenced from a contoso repo collapsed onto
  contoso's `platform` team).

### Migration

Forward-only wipe + re-sync. `packages/core-writer/src/neo4j/migrations.ts`
ships `runCanonicalIdMigration(client)`, run unconditionally from
`main.ts` on every `core-writer` boot. It deletes
`Repository`/`Team`/`Pipeline` nodes whose `id` still matches the old
single-segment shape (regex `^shipit://<label>/default/[^/]+$`), plus
matching `_LinkingKey` nodes. The regex filter leaves new-format IDs
untouched, so once everyone's migrated it's two no-op Cypher queries per
boot — no gate needed.

The next `Sync now` from each connector regenerates everything in the
new format.

## Alternatives Considered

- **Replace `default` with `<org>` (`shipit://repository/<org>/<name>`)** —
  rejected: conflates org scoping with environment scoping. The `default`
  namespace is a real semantic (other entity types use `'prod'`, `'staging'`),
  not a placeholder.
- **Org-scope `Person` too** — rejected: contradicts GitHub's global-login
  model and breaks any cross-org reuse of a Person node.
- **Alias layer in resolver for one release** — rejected: adds permanent
  code that must be removed later. Overkill for current scale (pre-customer).
- **Explicit Cypher migration script with org backfill** — rejected: more
  work than re-syncing, and re-sync produces identical results since the
  source of truth is upstream.

## Consequences

- Multi-org users no longer corrupt the graph by connecting two orgs with a
  shared repo name.
- Existing self-hosted dev DBs need a one-time migration: set
  `SHIPIT_CANONICAL_ID_MIGRATION=1` on the `core-writer` process and restart,
  then `Sync now` from the UI. See `docs/migrations/canonical-id-org-namespacing.md`.
- MCP tool output now returns the longer canonical-ID form. External
  integrations that pinned the old shape need updating.
- `_source_org` already differs between orgs, so any downstream code that
  joins on `_source_org` is unaffected.

## Revisit Triggers

- A second multi-tenant source connector (Jira workspaces, Datadog orgs) —
  we'll want to extend the same `buildScopedCanonicalId(label, ns, scope, name)`
  helper rather than re-deriving the pattern per connector.
- A future tenancy model in the writer (e.g., multi-customer SaaS) — at that
  point the `namespace` segment may also need to become tenant-aware.

## Related

- [github-connector-architecture-v1](./github-connector-architecture-v1.md)
- [github-installation-picker](./github-installation-picker.md)
