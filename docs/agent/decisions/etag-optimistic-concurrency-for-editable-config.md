---
type: decision
status: active
created: 2026-05-20
updated: 2026-05-20
author: claude-opus-4-7
tags: [config, concurrency, etag, api-server]
importance: core
---

# ETag optimistic concurrency for every UI-editable config surface

## Context

Three services now write back to `shipit.config.local.yaml`:

- `SchemaService` (`config/shipit-schema.yaml`)
- `ConnectorRegistry` (`connectors.instances[]`)
- `GitHubAppService` (`connectors.github.app.*`)

Two tabs, two operators, even one human + the scheduler can race a write. Without a check, the loser silently overwrites the winner.

## Decision

Every service that exposes a UI-editable resource follows the **same ETag pattern** (introduced for the schema editor per ADR-016, now extended):

1. **In-memory hash**: each service keeps `currentHash` = `sha256(canonical-serialized current state)`. For collections (the registry), the hash is **per-instance**, not collection-wide.
2. **GET returns `ETag: "<hex>"`** as a strong validator (RFC 7232). No `W/` weak prefix — strong validator semantics are what we want.
3. **PUT/PATCH/DELETE requires `If-Match: "<hex>"`** when the client read the resource. Missing header is treated as "force write" (used by initial-add flows like the wizard's first connector POST).
4. **Mismatch → 409** with body `{ error: { code: "VERSION_CONFLICT", … }, serverHash: "<hex>" }`. Client gets the new hash so it can rebase without an extra GET.
5. **Atomic disk write**: tempfile (`.<pid>.<ts>.tmp`) + `renameSync`. Mid-write crash leaves the active file readable.
6. **Comments survive**: round-trip through `yaml.parseDocument` + `setIn`. We're not stringifying our in-memory object.

Client side: `EtagConflictError` (base class) + `SchemaConflictError` (subclass kept for backward compat with the existing schema editor handler).

## Alternatives Considered

- **Last-write-wins**: easier, but a stale tab can wipe a fresh edit silently. Loud failure beats silent loss.
- **Locking (advisory `If-Unmodified-Since` style)**: timestamps are coarser than content hashes; identical content edited twice would produce different timestamps that disagree about whether anything changed.
- **One global config hash**: amplifies the conflict surface — every connector write would race every schema write.

## Consequences

- Three services share one pattern. New editable surfaces follow it by copy/adapt: SHA-256 canonical, GET sets ETag, PUT/PATCH/DELETE check If-Match, atomic temp-write, in-memory hash refresh on success.
- `parseDocument`+`setIn` is non-negotiable for any YAML write — the human-edited comments in `shipit.config.yaml` and `.local.yaml` must survive a write from the UI.
- Tests across `SchemaService`, `ConnectorRegistry`, and `GitHubAppService` cover the 409 path explicitly.

## Revisit Triggers

- Move from YAML to SQLite: pattern still applies (resource version column instead of content hash) but implementation changes.
- A service needs to write multiple resources atomically (cross-resource transactional update) → ETag isn't enough; need a different boundary.

## Related

- [github-connector-architecture-v1](./github-connector-architecture-v1.md) — invokes this pattern across two new services
- [live-reference-for-hot-reload](../patterns/live-reference-for-hot-reload.md) — orthogonal: ETag handles concurrency, live ref handles propagation
- ADR-016 in `docs/adrs/` — original ratification for the schema editor
