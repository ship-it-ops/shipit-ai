---
name: per-node-source-connector-id
description: Every Neo4j node carries the connector-instance ID that last wrote it; surfaced as a first-class filter/display dimension.
type: decision
status: active
created: 2026-05-27
updated: 2026-05-27
author: claude-opus-4-7
tags: [neo4j, provenance, connectors, schema, ui]
importance: core
---

# Persist source connector instance on every node and surface it across the UI

## Context

Provenance lived on every node before this change, but only at the **connector
type** layer — `_source_system: 'github'`, `_source_org: 'github/acme-corp'`,
`_source_id: 'github://acme-corp/payments-api'`. The actual connector
**instance** ID (e.g. `gh-acme-prod`) was on the `EventEnvelope.connector_id`
but the writer didn't persist it onto the node. Two GitHub connectors pointed
at different orgs were indistinguishable from each other in the graph
(`_source_system: 'github'` for both); the catalog/explore surfaces had no way
to display "this entity came from connector X" or to filter by it.

User asked to "showcase which connector a resource is coming from" and to
"filter by connectors". Granularity choice (asked + answered): **both
connector type AND instance**.

## Decision

1. **`CanonicalNode._source_connector_id?: string`** is now part of the shared
   type (`packages/shared/src/types/canonical.ts`). Optional because pre-existing
   nodes from before this change don't have it until they're re-synced.
2. **The writer — not the normalizer — sets the field.** Normalizers run
   inside a connector package and don't know which _configured instance_
   dispatched them. The `EventEnvelope.connector_id` is the authoritative
   source; `CoreWriter.processBatch` stamps it onto each node right before
   `writeNode`. See `packages/core-writer/src/writer.ts`.
3. **Cypher `mergeNode` writes `_source_connector_id` alongside the existing
   provenance fields**, with most-recent-writer-wins semantics matching
   `_source_system` / `_source_id` (multi-source aggregation still lives in
   `_claims` for the resolver).
4. **API**:
   - `GET /api/graph/overview` and `GET /api/graph/search` accept
     `?sourceSystem=…&sourceConnectorId=…` filters.
   - `GET /api/graph/sources` returns the distinct
     `(sourceSystem, sourceConnectorId)` pairs present in the graph with
     entity counts. Dynamic facet population.
5. **Web UI**:
   - `packages/web-ui/src/lib/connector-identity.ts` is the single source of
     truth for rendering a node's source as a `ConnectorIdentity`
     (`type`, `connectorId`, `displayName`, `shortName`, `resolved`).
   - `ConnectorPill` component (`packages/web-ui/src/components/connectors/connector-pill.tsx`)
     renders the identity uniformly across catalog, entity detail, and the
     global search dropdown.
   - Catalog table has a new "Source" column + facet (with a `${type}:*`
     wildcard for "any instance of this type").
   - Explore graph FilterPanel has a Source facet, dynamically populated
     from `/api/graph/sources`; selections drive Cytoscape node visibility.

## Alternatives Considered

- **Set `_source_connector_id` in the normalizer** — rejected. Normalizers
  receive raw API responses and don't have a handle to the dispatching
  instance ID. Pushing the instance ID through the normalize-signature
  pollutes every connector for one writer-side concern.
- **Use `_source_org` as the instance discriminator** — rejected. Different
  GitHub connectors can target the same org (per-org App override; multi-key
  rotation); the instance ID is the only stable user-controlled identifier.
- **Migrate existing nodes with a one-shot Cypher pass** — rejected for v1
  (per user). Forward-only — old nodes show `_source_system` only until their
  next sync rewrites them. The `ConnectorPill` handles the missing-instance
  case by rendering the type alone with a dimmed style.
- **Persist a `_source_connectors: string[]` array** for multi-writer
  aggregation — deferred. Tracked in plan's "out of scope" section.

## Consequences

- **Forward compatible**: optional field means existing fixtures, tests, and
  envelopes still type-check. No DB migration on deploy.
- **Forward-only data flow**: pre-existing nodes need a re-sync to populate
  the field. UI degrades gracefully with a dimmed pill.
- **Catalog/explore now adapt automatically** when a new connector type is
  added — both the facet options and source distinction come from the data.
- **A connector deletion leaves stale `_source_connector_id` references** on
  any entities the deleted connector wrote that haven't been overwritten by
  another writer since. UI marks these as `resolved: false` and renders the
  raw ID so users can still match against config. A cleanup job is out of
  scope for v1.

## Revisit Triggers

- A second connector type ships (Kubernetes, GitLab, …) and we observe two
  connectors converging on the same canonical entity — multi-source pill
  display becomes valuable; introduce `_source_connectors: string[]`.
- Pre-existing nodes never get re-synced (a connector is paused/disabled for
  weeks) and the "unresolved" pill grows old in the UI — consider a
  scheduled, idempotent re-sync pass.
- Per-claim provenance from `_claims` becomes the primary lens (e.g.
  reconciliation UI needs to show every claimant) — extend `ConnectorPill`
  to render a stack of pills rather than a single most-recent.

## Related

- [github-connector-architecture-v1](./github-connector-architecture-v1.md) — connector instance shape
- [core-writer-runs-as-its-own-process](./core-writer-runs-as-its-own-process.md) — the writer that now stamps the field
- [internal-node-label-underscore-prefix](../patterns/internal-node-label-underscore-prefix.md) — `_`-prefix property convention
- [canonical-id-org-namespacing](../open-questions/canonical-id-org-namespacing.md) — the per-instance ID is a stepping stone; canonical IDs still collide on repo name across orgs.
