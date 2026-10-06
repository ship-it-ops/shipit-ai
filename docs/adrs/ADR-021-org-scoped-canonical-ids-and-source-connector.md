# ADR-021: Org-Scoped Canonical IDs and Per-Node Source Connector

## Status

Accepted

## Date

2026-05-30 (source connector id: 2026-05-27)

## Context

Repository, Team and Pipeline canonical ids were `shipit://<label>/default/<name>`. Once a user connected two orgs that shared a repository name, the identity reconciler merged both onto one node. Separately, a node recorded which connector _type_ wrote it but not which configured _instance_, so two GitHub connectors were indistinguishable in the catalog.

## Decision

- Ids owned by a GitHub org gain an org segment inside the `default` namespace: `shipit://repository/default/<org>/<name>`, `shipit://team/default/<org>/<slug>`, `shipit://pipeline/default/<org>/<repo>-<workflow>`. `Person` stays global (`shipit://person/default/<login>`) because a GitHub login is global. The namespace segment keeps its environment meaning for other entity types.
- Migration is forward-only: `core-writer` deletes nodes still in the old shape at boot and the next sync regenerates them (`docs/migrations/canonical-id-org-namespacing.md`).
- Every node carries `_source_connector_id`, stamped by the writer from the envelope's `connector_id` (normalisers do not know the instance). `GET /api/graph/sources` lists the distinct sources with counts; the catalog and the explorer filter by them; one `ConnectorPill` renders the identity everywhere.

## Consequences

### Positive

- Two orgs can share repository names without corrupting the graph.
- The catalog says which connector produced an entity and can filter by it.

### Negative

- External consumers that pinned the short id form had to update; MCP tools return the longer form.
- Pre-existing nodes show the connector type only until their next sync.

### Neutral

- A second multi-tenant source should reuse `buildScopedCanonicalId` rather than re-derive the pattern.

## Alternatives Considered

### Replace `default` with the org

- **Cons:** Conflates org scoping with environment scoping, which other labels use.

### Org-scope `Person` too

- **Cons:** Contradicts GitHub's global login model.

## References

- `docs/agent/decisions/canonical-id-org-namespacing.md`, `per-node-source-connector-id.md`
- `packages/shared/src/identity/canonical-id.ts`
