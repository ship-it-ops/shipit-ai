---
type: plan
status: active
created: 2026-10-02
updated: 2026-10-04
author: claude-session-2026-10-01-knowledge-connectors
tags: [knowledge, connectors, slack, jira, confluence, github, retrieval, suggestions]
importance: core
---

# Knowledge connectors and the knowledge layer (Slack, Confluence, Jira, GitHub text)

## Goal

Ingest what people wrote in Slack, Confluence, Jira and GitHub into an indexed store that
agents and Ask can search with citations, link that content to the graph entities it
mentions, and let it change the graph only through suggestions a person accepts. The
connectors add no resources to the graph.

## Approach

Spec: `docs/superpowers/specs/2026-10-02-knowledge-connectors-design.md`. Owner decisions:
[knowledge-layer-v1-foundations](../decisions/knowledge-layer-v1-foundations.md).

- A second SDK contract, `KnowledgeConnector`, produces documents. Fetching runs in
  api-server on the connector-type factory and writes to Postgres.
- A new `knowledge-worker` process claims pending documents from Postgres, chunks, embeds
  through Vertex and links them to entities deterministically.
- Hybrid search (pgvector plus full text, fused by rank) is exposed as five read tools
  under service `knowledge` in the agents tool gateway.
- A suggestions inbox reviews identity matches, container mappings and relations.

## Build order

| #   | Milestone           | Rough size |
| --- | ------------------- | ---------- |
| K0  | Foundations         | 2 weeks    |
| K1  | GitHub text         | 2 weeks    |
| K2  | Retrieval and tools | 2 weeks    |
| K3  | Jira and Confluence | 3 weeks    |
| K4  | Slack               | 2 weeks    |
| K5  | Suggestions         | 2–3 weeks  |
| K6  | Release hardening   | 1 week     |

## Files to Touch

- `packages/connector-sdk/src/` — `KnowledgeConnector`, `KnowledgeSink`, `KnowledgeHarness`
- `packages/knowledge/`, `packages/knowledge-worker/` — new
- `packages/connectors/slack/`, `packages/connectors/atlassian/` — new
- `packages/connectors/github/src/knowledge/` — new module
- `packages/api-server/src/services/connector-types/` — `buildKnowledge`, three new types
- `packages/api-server/src/services/` — `KnowledgeSyncScheduler`; `routes/` — knowledge routes and the connector role gate
- `packages/api-server/config/github-app-manifest.json` — `issues: read`, two events
- `packages/shared/src/config/schema.ts` — `knowledge` section, new instance schemas
- `db/migrations/` — knowledge tables
- `packages/agents`, `packages/agent-runner` — catalog entry, executors, gateway ceiling 5

## Coordination with the agents workstream

Another agent is planning agent building and orchestration on the same branch. Shared
touchpoints, all listed in the spec under "Changes requested of the agents spec":

1. The built-in tool catalog gains service `knowledge`.
2. The tool gateway gains ceiling 5: writes need approval after a knowledge read.
3. The Graph assistant seed grants `knowledge` read.
4. The Postgres instance becomes pgvector on Postgres 17; migration numbers are allocated
   at merge time.

The Postgres infra brief belongs to that workstream. A copy is in the infra repo's inbox
(`shipit-ai-infra/docs/agent/status/incoming-brief-agent-platform-postgres-vertex-2026-10-01.md`)
and nobody has started on it. The addendum
`docs/agent/briefs/infra-pgvector-for-knowledge.md` has NOT been placed in the infra repo;
it should go there before that work starts, with the owner's say-so.

The Postgres foundation this plan needs (`packages/agents`, `db/migrations/0001_agents.sql`,
`pnpm db:migrate`, Postgres in compose and CI) **was executed by the agents workstream on
2026-10-03** (commits `21a4c4a`..`36524db` on `ai-agents-design`). K0 builds on that code,
and swaps the compose and CI Postgres image for a pgvector image.

## Verify in spikes before building on them

- **K0:** `gemini-embedding-2` through `@ai-sdk/google-vertex` (dimensions, task type,
  normalisation); secretlint used as a library at runtime.
- **K1:** whether `issues: read` can be added to a manifest-created GitHub App in its
  settings without recreating it, and what each installation then has to approve.
- **K3:** the exact Atlassian token scopes; `atlas_doc_format` versus `storage` for
  Confluence bodies; how page restrictions inherit from ancestors; comment paging on
  `issue/bulkfetch`.
- **K4:** whether a Slack retention purge is visible to the reconcile pass.

## Deferred work (do not lose)

The spec's "Deferred work" section is the full list with a trigger for each item. The ones
most likely to be asked for first:

1. **Permission mirroring** — per-user filtering, then private Slack channels and
   restricted spaces. The `acl` columns and `visibilityPredicate` are the seam.
2. **Legal reads** — Slack commercial distribution; Atlassian Developer Terms §6(f).
   Required before any paid or hosted tier.
3. **Slack live-search backend** behind `KnowledgeSearchBackend`.
4. **Event-driven freshness** — Slack events, GitHub webhooks, Jira webhooks.
5. **Semantic search in the web UI** — needs api-server to hold the Vertex role, or the
   worker to embed queries. Left out because api-server is the internet-facing process.
6. **Knowledge tools on the external MCP server.**
7. **Reranking and model-generated chunk context**, gated on the evaluation set.
8. **More sources** — GitHub Discussions, Google Drive, Notion, Linear, PagerDuty, Jira
   changelog; files and attachments.
9. **Graph enrichment from sources** — `Person` property claims, an expertise
   relationship type, property suggestions, auto-applying high-confidence suggestions.
10. **Moving connector fetch out of api-server** when the scheduler is extracted.

## Status

Spec written 2026-10-02 and **approved by the owner on 2026-10-03**, including the nine
choices in its "To confirm in review" section (shown in summary, not individually confirmed).

**K0 (foundations) implemented on `ai-agents-design`, 2026-10-03/04**, natively from
`docs/superpowers/plans/2026-10-03-knowledge-foundations.md`, one commit per task:
`427fd6f` (plan), `37ee7eb` (package, pgvector image, db:bootstrap), `2d1526a` (0002
migration, harness), `d878d2d` (config section, LastRun.facet), `8e3c8f7` (SDK contract,
harness, fixture), `3994296` (redaction, hashing), `0dbd710` (chunkers), `2a5f71c` (store,
sink), `77f8d22` (embedder), `be3bf31` + `f63fe2f` (pipeline, loop), `b47ccbb`
(knowledge-worker), `32ffe7a` (scheduler, composite runner), `50163b5` (status service,
route, boot wiring), `52650e1` (Task 13 docs), `b5882bf` (review fixes). All pushed.

Hands-on on the local stack (2026-10-04): pgvector 0.8.7 on Postgres 17.11; `0002` applied;
`GET /api/knowledge/status` answered `ingestionAvailable: true` with `embedding` failing
(no Vertex project locally) and `worker` failing until `knowledge-worker` ran, then
`worker: ok` (heartbeat TTL 49 s). The worker image built locally and its runtime bundle
resolved `@shipit-ai/knowledge` and the Vertex provider. **Not done:** a live Vertex
embedding call (no ADC in the session); the worker never embedded a real document. The
first live run is the K1 hands-on check.

Learned while executing (also in the plan's ledger):

- pgvector is not trusted and lives in `public`: every test harness that applies
  `db/migrations/` needs `public` on its `search_path` (the agents harness gained it).
- `db:bootstrap` uses `pg` directly so it runs under tsx with no build; CI bootstraps
  before the integration suites.
- secretlint's aws rule only scans access key IDs with `enableIDScanRule`; the
  privatekey rule needs a 100+ char body. Test fixtures use a GitHub token and a PEM.
- The agents workstream (same branch, same tree) holds `0003_runs.sql` and
  `EXPECTED_SCHEMA_VERSION '0003'`; K0 kept `0002` and added no further migration.

**Whole-branch review (2026-10-04, fresh reviewer):** "ready with fixes" — 2 Critical, 9
Important, 10 Minor. All Critical and Important items were fixed with a failing test first in
`b5882bf`: an unchanged re-send no longer clears a document's claim stamp (failed documents
stayed unretryable); the worker's write-backs apply only while the row is still its claim (a
tombstoned or edited document could get its old chunks back); redaction now covers title,
heading paths and attributes; restricted stubs carry no content fields; reconcile batches
never move the poll checkpoint; prune is scoped to the listing's start time and refuses an
empty listing over a populated container; one run per connector at a time; containers are
visited least recently polled first; Vertex parallelism is capped and the SDK's RetryError is
unwrapped; the disabled worker idles instead of exiting; `knowledge.enabled` is `false` in the
committed config until the first release (local example sets `true`).

Rulings recorded in that pass: sync jobs run while `ingestionAvailable` (database, schema,
extension), not `available` — a dead worker must not stop fetching (spec §Feature gating
amended); the worker's fail-loudly boot on missing prerequisites stands (core-writer
precedent; spec amended); a missing pgvector blocks `0002` and therefore agents (accepted
consequence of decision 10); permanently failed documents wait for the admin reindex route
(K2/K3); `maxDocumentChars` is enforced by connectors from K1.

Deferred minors from the review (not fixed, by rule): a document that crashes the worker is
reclaimed every 10 minutes forever and there is no claim renewal for two workers; a manual
trigger skipped as unavailable leaves the status `running`; `CompositeConnectorRunner` lets a
graph start/stop throw skip the knowledge facet and reports only the graph side of a
dual-facet connector (matters at K1); Slack-thread overlap can exceed `maxChunkTokens` with
very large messages; the worker's container-name cache never refreshes; "Agent features:
database configured." logs when only knowledge opened the pool; moving an existing compose
volume from the Alpine to the Debian image changes collation under text indexes (docs should
say reindex or reset); permanently failed rows stay in the claimable partial index; the
Vertex embedder is tested only through its seam. Also deferred: `enableIDScanRule` for the
secretlint aws rule (AWS key IDs are not flagged by default).

**Independent audit (2026-10-04, second session).** Gates green uncached
(typecheck, build, unit suites, knowledge 34 and agents 44 integration tests on pgvector). All 13
tasks delivered, every Global Constraints value matches. Bugs found, the first three reproduced
against Postgres:

1. A document tombstoned or restricted and then restored with the same content ends `indexed`
   with zero chunks: the tombstone and the restricted branch delete chunks but leave
   `indexed_hash`, so the pipeline's unchanged shortcut fires (`store.ts` tombstone and restricted
   branch, `index-pipeline.ts` unchanged check).
2. A `secretlint-disable` comment line in content switches redaction off for the rest of that
   string (the recommended preset bundles the filter-comments rule); the secret is stored.
3. A document edited down to no segments is marked `skipped` but keeps its old chunks.
4. knowledge-worker awaits the Redis `subscribe` before starting the loop; with Redis configured
   but down at boot it never indexes (ioredis queues the command forever).
5. `GET /api/knowledge/status` and the sync gate await a Redis `get` with no timeout; same hang.
6. A knowledge run that throws (`harness.run`, `buildKnowledge`) records no run history.
7. Embedding reuse is keyed on chunk text, but prefix + text is what is embedded: identical text
   under two headings gets one vector, and a rename keeps the old vectors.
8. The empty-listing prune guard never resolves, so a container whose documents were all deleted
   upstream keeps them (against decision 13).
9. Reconcile visits containers in `last_polled_at` order, which only a stored batch moves; under
   a tight budget the same containers can go unpruned every night.

Contract gaps to settle in the K1 plan: prune is container-wide with no per-kind scope (a GitHub
connector listing only issue ids would tombstone every PR and doc); no deadline or abort signal
reaches the connector; no channel for a non-failure note, and any thrown 403 marks the connector
degraded. Docs: the compose `knowledge-worker` service cannot index as written (unset
`NEO4J_USER`/`SHIPIT_API_URL`/`SHIPIT_WEB_ORIGIN`, committed config has `enabled: false`, no ADC
mount); `local-development.md` and the worker infra brief never mention `knowledge.enabled` and
the brief's "Done when" cannot be met from the committed config; no collation note for the
Alpine-to-Debian volume move. Weak tests: the "incomplete listing never prunes" fixture throws
before the first page; nothing applies `0002` without the extension; the backoff schedule and
`IndexLoop.start/stop` are untested.

**Audit fixes (2026-10-04, same session).** All nine
bugs fixed test-first; the three contract gaps closed additively in the SDK:

- 1 and 3: tombstone, restricted stub and `markSkipped` clear `indexed_hash`/`index_version`;
  `markSkipped` deletes the old chunks in the same transaction.
- 2: the linter is shown a copy with `secretlint-disable|enable` blanked (same length); the
  preset has no switch for its filter-comments rule (`disabled: true` on it did not work).
- 4: `knowledge-worker` starts the loop before the Redis subscription and does not await it
  (`wake.ts`); a wake-up during a batch is remembered; the loop's wait timer is no longer
  unref'd.
- 5: the worker check has a 2 s Redis timeout and concurrent status calls share one
  computation. `AiStatusService.checkRunner` has the same hang; reported to the agents session.
- 6: any throw in a knowledge run records a failed run; the harness also turns a failing
  `selectedContainers`/`upsertContainers` into a recorded error.
- 7: `text_hash` is sha256 of prefix + text (what is embedded).
- 8: a second consecutive empty listing is believed; the first is remembered in
  `knowledge_state` under `empty-listing:<connector>:<container>`. No migration.
- 9: `selectedContainers(mode)` orders by the stamp of that mode; `markVisited` stamps every
  finished container; only a batch with a checkpoint stamps `last_polled_at`.
- Contract: `prunableKinds` on the connector and `kinds` on the prune; `signal` and `deadline`
  on `fetchChanges`/`reconcile`/`listDocumentIds`, with the scheduler aborting on `close()`;
  `notes` on a batch, carried to the run record. A thrown 401/403 still sets `authFailed`:
  a connector reports a soft 403 as a note instead of throwing.
- Tests added for: an incomplete listing (fixture now fails after its first page), `0002`
  against a database without the extension, the 4^n backoff, `IndexLoop` start/stop/kick.

- Docs: the compose `knowledge-worker` block loads the config and mounts ADC; `local-development.md`
  says how to switch the layer on, how to run the worker on the host, and what to do about the
  Alpine-to-Debian collation change; the worker infra brief names every env var and
  `knowledge.enabled`.

Still open: the deferred minors listed above; surrogate pairs at hard cuts; `enableIDScanRule`.
The agents session bounded the same Redis wait in `AiStatusService` in `bb650d3`.

**K1 is three plans (decided 2026-10-04).** The spec's K1 covers three subsystems that each
ship on their own: **K1a** the GitHub text facet, instance config, container routes, the
connector admin gate and the first live embedding; **K1b** the alias dictionary, deterministic
linking, references, people matching and their migration (`0005` or later), with the timeline
and document routes; **K1c** the web UI (GitHub Knowledge section, container picker and
acknowledgement, permission banner, entity Knowledge tab).

**K1a (GitHub text) implemented on `ai-agents-design`, 2026-10-04**, natively from
`docs/superpowers/plans/2026-10-04-knowledge-github-text.md`, test first, one or more commits
per task: `800c302` (manifest asks for `issues: read`), `46a21c5` (the `knowledge` block on a
GitHub connector; per-instance switch on the scheduler; PATCH accepts the block), `d56bde3`
(documents from pull requests, issues and Markdown), `b3b5d47` (GraphQL fetchers), `f561b64`
(docs from the tree; rate-limit waits), `de30a13` (SDK: an error after the shutdown signal is
the run cut short, not a failure), `e2a4a9c` (a refused listing is a missing permission too),
`2e3eafa` (`GitHubKnowledgeConnector`), `9bd3196` (the `github` type builds the knowledge
facet; a manual sync reaches both facets), `fa904e2` (container routes, the admin gate, the
purge), and the commit that carries this note (hard cuts keep surrogate pairs whole, two unused
dependencies dropped, docs).

What it does: an admin switches knowledge on with `PATCH /api/connectors/:id`
(`{"knowledge":{"enabled":true}}`, the block is replaced whole), lists repositories with
`POST …/containers/refresh` and `GET …/containers`, and selects with
`PUT …/containers/:containerId`. A repository that is not public needs
`acknowledgeVisibility: true`. Deselecting deletes the content through the worker within about
a minute. Every non-GET route under `/api/connectors` now needs role `admin`, the manual sync
and the probe included; the web UI does not hide those actions from members yet (K1c).

Decisions taken while executing, beyond the plan (all in the commits above):

- The K1 spike: `issues: read` can be added to a manifest-created App in its settings
  (Permissions & events) without recreating it; each installation then approves the request.
- A request aborted by shutdown ends the run as cut short, not as a failed container.
- A `FORBIDDEN` answer on the issues listing is treated like the missing permission.
- The worker's periodic chores (purge, tombstone retention) live in
  `packages/knowledge-worker/src/housekeeping.ts`, tested, not inline in `main.ts`.
- `storeBatch` refuses a container that is no longer selected (closes the K0 deferred minor).
- The composite runner starts and stops the knowledge facet even when the graph facet throws,
  and a manual sync triggers both (closes the K0 deferred minor).

Hands-on on 2026-10-04 against the real `ship-it-ops` installation, in an isolated setup (own
port, scratch Postgres database, Redis database 5):

- Status: `ingestionAvailable: true` with the worker check failing until the worker ran, then
  `available: true`.
- `refresh` listed 6 repositories (private ones `restricted`, public ones `open`); a private
  one without the acknowledgement answered 409 `VISIBILITY_NOT_ACKNOWLEDGED`.
- One sync of `ship-it-ops/shipit-ai` (14 days of history, two doc files) stored 13 pull
  requests and 2 docs; the run was recorded with `facet: knowledge`, `status: success` and the
  note `issues_permission_missing`: that installation has not been granted Issues: read.
- Deselecting purged all 15 documents within a minute and reset the checkpoint.
- With no database configured the server booted, `/api/connectors` answered as before and the
  containers route answered 503 `KNOWLEDGE_UNAVAILABLE` naming the database.

**Not done: the first live Vertex embedding.** Every embedding call failed with
`invalid_grant` / `invalid_rapt`: the machine's Application Default Credentials need an
interactive `gcloud auth application-default login`. The 15 documents went to `failed` with
the error recorded; nothing was embedded, so the provider option names in
`packages/knowledge-worker/src/vertex-embedder.ts` are still typechecked only. Redo the first
two hands-on steps of the plan once the credentials are refreshed. A GitHub rate limit longer
than a run's budget was not provoked live either; it is unit-tested.

Found while doing it, not fixed:

- **A credentials failure spends retry attempts.** It is classified non-retryable, so each
  claimed document loses one of its five attempts; an outage longer than about 5.7 hours
  (4 + 16 + 64 + 256 minutes) leaves every claimed document permanently `failed` until the
  admin reindex route exists (K2/K3). Worth a circuit breaker: treat an auth failure as the
  embedder being unavailable, pause the loop, spend no attempts.
- **The event bus ignores the database index in the Redis URL** (`redis://host/5` still
  publishes to database 0), while the schedulers and the run store honour it. The hands-on
  run found this the hard way: 50 graph events from its manual sync went to
  `bull:shipit-events` in the dev Redis database 0. They were left there; core-writer applies
  them idempotently when it next runs.
- Reviews beyond the first fifty per pull request, and review comments beyond the first fifty
  per review, are not fetched; the document is flagged `truncated` when reviews overflow.

**Whole-range review of K1a (2026-10-04, fresh reviewer): "ready to merge with fixes"** — no
Critical, ten Important, twelve Minor findings; it agreed with every ruling made while
executing. All ten Important findings were fixed with a failing test first, in `5ceb9b5`
(SDK), `e980f18` (store and sink), `f71dbc1` (connector) and `f1dc690` (api-server):

1. Deselect, purge and reselect during a run left the repository permanently incomplete (the
   run wrote its old checkpoint over the fresh backfill). `storeBatch` now locks the container
   row and refuses a batch whose container is not selected or does not hold the checkpoint the
   run holds (`KnowledgeContainerChanged`); the harness skips that container with a note.
2. A member could replace the shared GitHub App through the manifest flow, which is made of
   GETs. Launch, callback and pending-credentials are now admin-only.
3. A GraphQL rate limit (HTTP 200 with a `RATE_LIMITED` error, headers on `err.headers`) was
   not recognised, so runs failed. It is recognised, remembered for the rest of the run, and
   ends the run through `KnowledgeRunCutShort`; the repository and member listings are paged
   inside the same wrapper, so a rate-limit 403 there no longer reads as an auth failure.
4. The heading pattern backtracked polynomially (16 s for a line with 5,000 spaces) and would
   have blocked the api-server's event loop. Headings are parsed by hand, in linear time.
5. Changing `docs.paths`, `docs.maxFileBytes` or `historyDays` had no effect on a repository
   that already had a checkpoint. The checkpoint now carries a fingerprint of the docs
   settings and the horizon each kind was backfilled to.
6. A UTF-16 Markdown file filled the text with NULs, which Postgres rejects, failing the batch
   on every run: blobs are decoded by byte-order mark and the sink strips U+0000 from every
   text field. The three kinds now sync independently.
7. Authors were unresolved for the whole first backfill, and never for bots and outside
   contributors: a batch carries its principals and the sink upserts them first; the admin's
   container refresh loads the organisation's members too.
8. Content outlived its connector: deleting a connector now deselects everything it holds,
   and a container the source no longer lists is shown, flagged `gone`, while it is selected
   or holds content.
9. The acknowledgement was checked once against a listing up to a day old: an unacknowledged
   selection now asks the source first, and a selected container that stops being open is
   left out of runs until acknowledged.
10. Tests for the branches that protect data: a truncated tree, docs spanning batches, a
    deletion-only change (the first two checked by mutation), rate-limit fakes in the shape
    Octokit really throws, the manifest routes in the gate test, housekeeping on fake timers.

Ruled, not fixed: a single item whose query fails persistently is not skipped (telling a
poisoned item from a GitHub incident needs a failure counter that survives runs; it now blocks
only its own kind for that repository, loudly); a container the source no longer lists is not
purged automatically (a transient listing fault would delete a repository's whole index).

Deferred minors from the review (not fixed, by rule): the abort signal reaches GraphQL and the
listings but not `getTree`/`getBlob`, and a sleep ignores a signal aborted before it began;
"Sync now" from the UI sends no mode, which for the knowledge facet is a reconcile (no documents
until the scheduled poll), and a failing knowledge trigger also prevents the graph trigger; the
refresh route turns a non-auth GitHub error into an opaque 500; `purgeRequested` deletes all
documents of up to 20 containers in one statement; `containersWithCounts` has no paging; every
poll re-fetches the item at each cursor; a refused issue-id listing on reconcile is an error,
not the note; doc URLs are not percent-encoded; `truncateDocument` can cut a surrogate pair
(unreachable with the default limit); a four-backtick fence containing a three-backtick line
ends early; the container `PUT` can select a `gone` container.

Left to the owner: switching a kind or the whole facet off stops fetching but leaves what is
stored in place until the container is deselected.

**Next:** refresh the credentials and run the live embedding; then the K1b plan (alias
dictionary, deterministic linking, references, people matching, their migration at `0005` or
later, the timeline and document routes), written against this code.

## Related

- [knowledge-layer-v1-foundations](../decisions/knowledge-layer-v1-foundations.md) — owner decisions and research findings
- [ai-agents-and-workflows](ai-agents-and-workflows.md) — the sibling plan this depends on
- [agent-platform-v1-foundations](../decisions/agent-platform-v1-foundations.md) — Postgres and Vertex foundation
- [redis-memory-limit-below-dataset-oomkills](../scars/redis-memory-limit-below-dataset-oomkills.md) — why no content or id lists enter Redis
- [docker-builder-copies-fixed-package-set](../scars/docker-builder-copies-fixed-package-set.md) — applies to every new package here
