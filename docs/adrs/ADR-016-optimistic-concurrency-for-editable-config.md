# ADR-016: Optimistic Concurrency for Editable On-Disk Config (ETag / If-Match)

## Status

Accepted

## Date

2026-05-20

## Context

Phase 3 added a visual schema editor (`packages/web-ui/src/app/configure/schema`) that lets a user mutate `config/shipit-schema.yaml` from the browser. That file is the canonical entity-type registry — node types, relationship types, property definitions, per-property resolution strategies. The reconciler reads it. The graph writer reads it. The MCP server reads it. Multiple humans (and, eventually, multiple agents) can be staring at the editor at the same time.

We need to prevent a load-edit-save cycle that silently clobbers another writer's work. We also need to prevent a partial-write from corrupting the file on disk when the process crashes mid-write. And we need users to understand what the impact of a schema change is _before_ committing — schema-migration-preview computes how many entities and relationships are affected by each rename/delete.

We considered several locking models (alternatives below). The web is built on optimistic concurrency control via HTTP ETags / `If-Match` — the canonical pattern, with cache friendliness as a side benefit. We adopted it explicitly because the failure mode (a rare 409 with a clear recovery UI) is much better than the alternatives (silent overwrite, pessimistic locks, or no concurrency story at all).

## Decision

Editable on-disk config (today: `config/shipit-schema.yaml`) uses HTTP optimistic concurrency, content-addressed by SHA-256 hash, with atomic writes and a mandatory preview-before-save flow.

**Hash and ETag.** `SchemaService` in `packages/api-server/src/services/schema-service.ts` keeps an in-memory `currentHash` — `sha256(utf8 bytes of the YAML file)` — alongside the parsed schema. The schema route returns the hash as a strong `ETag: "<hex>"` header on `GET /api/schema` and surfaces it as `SchemaWithHash` to clients.

**`If-Match` is required on writes.** `PUT /api/schema` accepts a `If-Match: "<hex>"` header. The service compares it against `currentHash`:

- If they match (or `If-Match` is absent and there's no prior hash), the write proceeds.
- If they differ, the service throws `SchemaVersionConflictError` carrying the current `serverHash`. The route maps this to HTTP 409 with the server hash in the response body so the client can branch on it.

The web UI's `saveSchemaYaml` parses the 409 specifically and throws a typed `SchemaConflictError` (`packages/web-ui/src/lib/api.ts`). The schema editor catches that error and opens a dedicated conflict dialog with two recovery paths: reload (discard local changes, refetch base) or keep editing against the new base (rebase the local draft).

**Atomic writes.** All schema writes go through tempfile + `rename`. `updateSchema` writes the new YAML to `<schemaPath>.<pid>.<timestamp>.tmp`, then `rename`s atomically into place. A mid-write crash leaves the active schema file untouched, so the next boot reads valid YAML instead of a half-written file. (The dev-user onboarding route uses the same pattern; see ADR-015.)

**History snapshots happen before the rename.** `updateSchema` reads the _previous_ file content, writes a timestamped snapshot to `schema-history/`, then performs the atomic write. History captures what we're moving _away from_; the new file isn't duplicated into history. Pruned to `HISTORY_LIMIT = 10` newest entries.

**Diff + migration preview gate the save UI.** Before the editor opens its save dialog, it runs `POST /api/schema/diff` (a static YAML diff) and `POST /api/schema/migration-preview` (which reads Neo4j to count affected nodes/edges per change) in parallel. The migration preview is _advisory_ — if it fails, the save can still proceed; the diff itself is the load-bearing check. Users explicitly confirm the change set in a `SchemaDiffView` before the PUT fires.

**Cypher identifier safety.** `schema-migration-preview` interpolates type and relationship names into Cypher (`MATCH (n:\`${nodeType}\`)`). The `backtick()` helper double-escapes any backtick in the identifier; names are sourced from a Zod-validated schema. Belt and suspenders, but documented as part of this ADR because the pattern lives here.

**Why this pattern, not pessimistic locking.** A schema change is a foreground human action — they sit on a draft for minutes, not milliseconds. A pessimistic lock would have to be coarse (one editor at a time) or fine-grained (per-node-type), and either way you need a release mechanism, a stuck-lock recovery story, and a UI that explains "someone else has the lock." Optimistic concurrency degrades to a rare 409 with an actionable dialog. The cost is paid by the second-saver, only when they hit the race; the first-saver never knows.

## Consequences

### Positive

- **No silent overwrites.** Two users save in either order; whichever loses sees the conflict dialog with a current-server-state recovery path.
- **No locks to acquire, hold, or recover.** Optimistic by design — failure cost is paid only by the loser of a race, only when a race actually occurs.
- **HTTP-native.** ETag/If-Match is a 25-year-old standard. Browser caches, intermediate proxies, and any future API client understand it without bespoke logic.
- **Mid-crash safe.** Atomic tempfile + rename means a kill -9 mid-write leaves a valid YAML on disk.
- **History is free.** Snapshot-before-rename captures every prior version in `schema-history/`. Reverting is a file copy.
- **Diff + migration preview surface impact before commit.** Users see "this rename affects 47 services" before clicking save, not after the reconciler stalls on a missing type.
- **Same pattern is reusable.** Any future editable on-disk config (entity-type schemas, reconciliation thresholds, RBAC rules) can adopt this end-to-end without bespoke design.

### Negative

- **In-memory hash is single-process state.** If we later scale the api-server beyond one replica, the hash is per-replica and stops being authoritative. **Mitigation:** Not in scope until ADR-007's HA strategy is executed. When it is, the hash moves to whatever shared store backs the schema file (or the schema moves out of the filesystem entirely; this ADR is consciously about the current single-writer-on-disk shape).
- **Diff + migration preview are two extra round-trips before save.** **Mitigation:** They run in parallel via `Promise.all`. Migration preview is allowed to fail without blocking the save flow.
- **Atomic-write tempfiles can leak on crash.** If the process dies between `writeFile(tmp)` and `rename(tmp → final)`, the tmp file persists. **Mitigation:** Tempfile names include `pid` and `timestamp` so they're easy to identify; the `unlink` fallback in the catch handles synchronous rename failures. A periodic cleanup of orphan tmp files is a future addition; the leak is bounded.
- **History grows linearly with edits.** **Mitigation:** `HISTORY_LIMIT = 10` prunes oldest after every write.

### Neutral

- The pattern is opinionated: every editable on-disk config gets the same shape (hash, If-Match, tempfile+rename, history). New surfaces should not re-invent it.
- Conflict resolution is _not_ automatic — there's no merge tool. The user picks between "discard mine" and "rebase mine." Three-way merge is a future addition.

## Alternatives Considered

### Alternative 1: Last-write-wins (no concurrency check)

- **Pros:** Trivial implementation.
- **Cons:** Silent data loss. A user spends 20 minutes editing, hits save, and overwrites someone else's earlier save with no warning. The whole point of an editor surface is collaboration; LWW is the worst possible default.
- **Why rejected:** It is the _exact_ failure mode this ADR exists to prevent.

### Alternative 2: Pessimistic lock (e.g., a `schema-lock` file or DB row)

- **Pros:** Definite ordering. The lock-holder cannot be raced.
- **Cons:** Lock acquisition is a foreground UX step. Stuck locks need a recovery story (and operationally always become stuck — the lock-holder closes their laptop). Lock granularity is a design problem: file-level locks block trivial parallel edits, type-level locks balloon complexity. Doesn't compose with history or migration preview cleanly.
- **Why rejected:** Operationally fragile. The schema is edited rarely; the contention is mild; the failure cost of a conflict is small. Pessimistic locking is the wrong tool for this load profile.

### Alternative 3: Version numbers instead of content hashes

- **Pros:** Simpler to display ("you're on v17, server has v18").
- **Cons:** Requires a separate authoritative version counter. Content hashing is free — the YAML _is_ the version. Hashes also catch accidental no-op writes (same content, no hash change, no history pollution).
- **Why rejected:** Content hashes give us versioning and idempotency for free; explicit version numbers add a counter we'd have to maintain in a separate place.

### Alternative 4: CRDT-style collaborative editing (real-time merge)

- **Pros:** No conflicts; multiple users edit live.
- **Cons:** Schema YAML isn't a freeform text document — most edits are structural (add a type, rename a relationship). CRDT operations on structured config are an open research area, not a 2-day implementation. The reconciler can't tolerate partial intermediate states anyway.
- **Why rejected:** Massively out of scope. The schema is edited by a small number of operators, infrequently; optimistic concurrency is sufficient.

### Alternative 5: Database-backed schema (move it out of the filesystem)

- **Pros:** No file-locking, no tempfile-rename, no in-memory hash issues. Native concurrency control via the DB.
- **Cons:** The schema is currently a YAML file that's checked into the repo and read at boot by every package. Moving it to a database adds a deploy-time dependency, breaks the "edit the file in a PR" affordance for emergencies, and is a much larger architectural change.
- **Why rejected:** Not the right scope of change. The YAML-on-disk model works; this ADR is the missing concurrency layer on top of it.
