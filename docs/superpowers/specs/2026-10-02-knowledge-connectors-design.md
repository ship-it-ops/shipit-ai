# Knowledge connectors and the knowledge layer v1 — design

**Date:** 2026-10-02
**Status:** Draft for review (design), pending implementation plans
**Scope:** one design for the whole first release of the knowledge layer. It fixes the
architecture and the contracts between parts. Implementation is planned per milestone
(§Milestones); each milestone gets its own plan under `docs/superpowers/plans/`. The Slack
and Atlassian wizards and the suggestions inbox get a short UI spec when their milestone
is planned, the way the Connector Hub did.
**Lineage:** owner decisions of 2026-10-01 and 2026-10-02 in
`docs/agent/decisions/knowledge-layer-v1-foundations.md`; plan note in
`docs/agent/plans/knowledge-connectors.md`.
**Sibling spec:** `docs/superpowers/specs/2026-10-01-ai-agents-and-workflows-design.md`
(the "agents spec"). This design consumes its Postgres foundation and its tool gateway and
asks for four small changes to it (§Changes requested of the agents spec).

## Problem

ShipIt-AI's graph knows what exists and how it is wired: services, repositories, teams,
deployments. It does not know what people said about any of it. The reasons behind a
decision, the story of the last outage, who has context on a migration and what work is in
flight live in Slack, Confluence, Jira and GitHub discussions. The agents being designed
in the sibling spec can read the graph and nothing else, so they cannot answer those
questions.

Three gaps stand in the way:

1. **The connector pipeline has one output shape.** `ShipItConnector.normalize()` returns
   nodes and edges, which travel through BullMQ to the core-writer and into Neo4j. There
   is nowhere for text content to go.
2. **There is no search index.** ADR-005 deferred vector search until the corpus was rich
   in natural-language text. These sources are that corpus.
3. **Nothing connects text to the graph.** A Jira ticket that names a service, or a pull
   request that mentions a ticket, creates no link anywhere.

## Goal

An admin opens the Connector Hub and adds Slack, Confluence or Jira, or switches on the
knowledge option of an existing GitHub connector, then picks the channels, spaces, projects
and repositories to index. Content is fetched, chunked, embedded and linked to the graph
entities it mentions. Agents and the Ask page then answer four kinds of question with
citations back to the source:

- **Operational history.** "What happened the last time payments-api went down, and how
  was it fixed?"
- **Decisions and rationale.** "Why did we move off the old queue? Where is the design
  doc?"
- **Who knows what.** "Who has context on the billing migration?"
- **Work status.** "What is in flight for this service? Which tickets block the release?"

Ingested content never becomes graph nodes. It reaches the graph in exactly one way: a
suggestion that a person accepts.

## Non-goals

Each of these is recorded with its trigger in §Deferred work.

- **Per-user permission filtering.** v1 is admin-curated and visible to every logged-in
  user. Source permissions are recorded, not enforced.
- **Private Slack channels, direct messages and Slack Connect channels.** Not listed, not
  indexed.
- **Event-driven freshness.** v1 polls. No Slack Events API, no Jira webhooks, no use of
  the GitHub webhook receiver for knowledge.
- **Live (federated) search** through Slack's Real-time Search API or Atlassian's Rovo MCP
  server. A seam is kept (§Retrieval); no implementation.
- **Semantic search outside the agent runner.** api-server has no Vertex role, so the web
  UI gets keyword search and entity timelines; semantic search goes through Ask and agents.
- **Knowledge tools on the external MCP server.**
- **Files and attachments.** Slack files, canvases and lists, Confluence attachments,
  images and PDFs are not indexed.
- **Reranking and model-generated chunk context.** v1 ships hybrid search with structural
  prefixes.
- **New graph node types or relationship types.** Suggestions propose only relationships
  the schema already defines.
- **Atlassian Data Center.** Cloud only.
- **A paid or SaaS distribution of the Slack connector.** See §Legal.

## Decisions

| #   | Decision                                                                                                                                                      | Rationale                                                                                                                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | **Indexed store in Postgres beside the graph**: documents, chunks and embeddings in Postgres, linked to graph entities by canonical id. _(owner, 2026-10-02)_ | Supports graph links, suggestions, cross-source ranking and people queries. Neo4j 5 cannot filter a vector search. A live-only design cannot affect the graph at all.                      |
| 2   | **Curated visibility now, mirroring later.** An admin selects containers; everything indexed is visible to every logged-in user. _(owner, 2026-10-01)_        | Matches `no-tenant-read-isolation-authenticated-sees-all`. Source permissions are recorded on containers and documents so mirroring can be added without re-ingesting.                     |
| 3   | **Deterministic links plus reviewed suggestions.** Nothing inferred changes the graph without a person accepting it. _(owner, 2026-10-01)_                    | The graph is curated. A wrong edge from a chat message is worse than a missing one.                                                                                                        |
| 4   | **Four sources in v1:** GitHub text (pull requests, issues, docs), Jira, Confluence, Slack. _(owner, 2026-10-01 and 2026-10-02)_                              | The owner chose all four, and chose to include GitHub issues even though it means every installation re-approves the App's permissions.                                                    |
| 5   | **Slack is indexed through a customer-created app**, with retrieval behind an interface so a live-search backend can replace it. _(owner, 2026-10-02)_        | Allowed today for a free self-hosted install with full rate limits. A paid tier needs a legal read first (§Legal).                                                                         |
| 6   | **Knowledge connectors never publish to the event bus and never create graph nodes.**                                                                         | The owner's framing: these connectors do not add resources to the graph.                                                                                                                   |
| 7   | **Fetching runs in api-server on the connector factory; indexing runs in a new `knowledge-worker` process.**                                                  | Reuses the registry, credentials, Connector Hub and run history. Keeps Vertex calls and CPU work out of api-server. Follows the Kubernetes connector and core-writer precedents.           |
| 8   | **Postgres is the work queue for indexing** (`FOR UPDATE SKIP LOCKED`), with a Redis pub/sub wake-up. No document content or id list enters Redis.            | The 2026-06-17 Redis OOM. One store of truth for "what still needs indexing"; nothing to reconcile between a queue and a table.                                                            |
| 9   | **pgvector with `halfvec(768)` and HNSW; built-in full-text search; reciprocal rank fusion.** Postgres 17 is the floor.                                       | Half the storage of `vector` with the same index limits. Built-in full text needs no further extension. Postgres 17 keeps `pg_textsearch` (true BM25, PostgreSQL licence) available later. |
| 10  | **pgvector is a baseline requirement of the Postgres instance**, installed once by a superuser before migrations run.                                         | The extension is not trusted, so `shipit_migrator` cannot create it. One migration directory and one sequence stay simpler than a second, optional one.                                    |
| 11  | **Embeddings come from Vertex AI** (`gemini-embedding-2`, 768 dimensions, explicit task types), through the AI SDK's Vertex provider.                         | Vertex is the platform's only model provider. One model for documents and queries.                                                                                                         |
| 12  | **Polling only in v1**, with a per-source reconcile pass for edits and deletions.                                                                             | Uniform across four sources. Confluence offers no webhooks to a token-based integration. Same choice the Kubernetes connector made.                                                        |
| 13  | **Deletions in the source hard-delete our copy.** Disconnecting a source or deselecting a container deletes its content.                                      | Slack's developer policy requires deletion. A copied message that outlives its original is a liability in any source.                                                                      |
| 14  | **Secrets are redacted at ingest**, before content is stored or embedded.                                                                                     | Chat and tickets contain pasted credentials. ADR-017's rule set is already in the repo.                                                                                                    |
| 15  | **A run that has read knowledge content needs human approval for every write and delete.**                                                                    | Ingested text is written by anyone who can post in a channel or open an issue. Removing unattended writes is the structural control against prompt injection.                              |
| 16  | **Source users are matched to existing `Person` nodes; no `Person` node is created.**                                                                         | Decision 6. Unmatched users stay as display names in Postgres.                                                                                                                             |
| 17  | **Model-extracted relations are opt-in and budget-capped.** Every other suggestion type is on by default.                                                     | Extraction costs a model call per document; the other generators are SQL.                                                                                                                  |

## Terms

- **Knowledge connector** — a connector that produces documents, not graph entities.
- **Container** — the unit an admin selects: a Slack channel, a Confluence space, a Jira
  project, a GitHub repository.
- **Document** — one retrievable item: a Slack thread, a Confluence page, a Jira issue, a
  pull request, a GitHub issue, a Markdown file.
- **Segment** — an ordered part of a document with its own author, time and heading: one
  message, one comment, one section.
- **Chunk** — the unit that is embedded and searched. Built from one or more segments.
- **Principal** — a user, bot or group in a source system.
- **Entity link** — a recorded connection from a document to a graph entity's canonical id.
- **Suggestion** — a proposed change to the graph, with evidence, awaiting review.

## Architecture & data flow

```text
   Slack     Confluence     Jira     GitHub (pull requests, issues, docs)
     \           |           |          /
      v          v           v         v
 ┌──────────────────────── api-server ───────────────────────────────────────┐
 │ connector registry + connector-type factory (existing)                     │
 │ KnowledgeSyncScheduler: poll and reconcile jobs, KnowledgeHarness           │
 │ PostgresKnowledgeSink: redact secrets, upsert documents, save checkpoint    │
 │ /api/knowledge/*  /api/connectors/:id/containers  suggestions accept/reject │
 └───────┬─────────────────────────────────────────────────────┬─────────────┘
         | SQL (documents with index_status = 'pending')        | accept
         v                                                      v
   ┌──────────┐      ┌──────────── knowledge-worker ────────┐  RelationEditService
   │ Postgres │<─────│ claim pending documents               │  (existing) ──> Neo4j
   │          │      │ chunk -> embed (Vertex) -> link       │
   │ documents│      │ relink when the graph's names change  │<── Neo4j, read-only
   │ chunks   │      │ suggestion generators, purge, cleanup │    (alias dictionary)
   │ links    │      └───────────────────────────────────────┘
   │ suggest. │
   └────┬─────┘
        | SQL, in-process (@shipit-ai/knowledge)
        v
   agent-runner: knowledge.* tool executors ──> tool gateway ──> Ask and agents
```

The api-server fetches because the credentials, the registry and the scheduler already
live there. The worker owns everything that costs CPU or money. The agent runner embeds
the query and searches in-process; it already holds the Vertex role. The three processes
share Postgres and nothing else in memory.

## Packages and processes

| Package                         | Kind    | Contents                                                                                                                                                                                                              |
| ------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/knowledge`            | library | `@shipit-ai/knowledge`. Zod schemas, Postgres repositories, `PostgresKnowledgeSink`, secret redaction, chunkers, alias dictionary and linker, hybrid search, tool definitions (metadata and handlers), status checks. |
| `packages/knowledge-worker`     | process | `@shipit-ai/knowledge-worker`. `src/main.ts` boots like `core-writer/src/main.ts`. Index loop, embedder, relinker, suggestion generators, purge and cleanup jobs, heartbeat.                                          |
| `packages/connector-sdk`        | changed | New `KnowledgeConnector` contract, `KnowledgeSink` interface and `KnowledgeHarness` (§Connector contract). `ShipItConnector` is untouched.                                                                            |
| `packages/connectors/slack`     | new     | Slack knowledge connector.                                                                                                                                                                                            |
| `packages/connectors/atlassian` | new     | Shared client (auth, rate-limit handling, pagination), ADF-to-text walker, and the `confluence` and `jira` knowledge connectors.                                                                                      |
| `packages/connectors/github`    | changed | New `knowledge/` module: pull requests, issues, docs. The graph connector is untouched.                                                                                                                               |
| `packages/api-server`           | changed | `KnowledgeSyncScheduler`, connector types `slack`, `confluence`, `jira`, a knowledge facet on `github`, routes in §API.                                                                                               |
| `packages/agent-runner`         | changed | Registers the `knowledge.*` executors; the gateway gains one ceiling (§Changes requested of the agents spec).                                                                                                         |
| `packages/agents`               | changed | Built-in tool catalog gains the `knowledge` service.                                                                                                                                                                  |
| `packages/shared`               | changed | Config schema: top-level `knowledge` section; connector instance schemas for the three new types; `knowledge` block on the GitHub instance.                                                                           |
| `packages/web-ui`               | changed | §Web UI.                                                                                                                                                                                                              |
| `db/migrations/`                | changed | Knowledge tables. Numbers are allocated at merge time (§Changes requested of the agents spec).                                                                                                                        |
| `docker/docker-compose.yml`     | changed | Postgres image becomes a pgvector image with an init script that creates the extension; adds `knowledge-worker`.                                                                                                      |
| `packages/api-server/config/`   | changed | `github-app-manifest.json` gains `issues: read` and the `issues` and `issue_comment` events.                                                                                                                          |

Per the scar `docker-builder-copies-fixed-package-set`, every new workspace dependency is
added in three places that must agree: the Dockerfile `COPY` list, the package's vitest
alias list, and the lockfile. `knowledge-worker` gets its own Dockerfile and a CI
docker-build matrix entry. Per the scar `web-ui-cannot-import-mcp-server-root`, web-ui
imports only types from `@shipit-ai/knowledge`, through a types-only entry point.

## Connector contract

A second contract in `@shipit-ai/connector-sdk`, next to `ShipItConnector`:

```ts
export type ContainerKind = 'channel' | 'space' | 'project' | 'repository';
export type DocumentKind =
  | 'slack_thread'
  | 'slack_channel_day'
  | 'confluence_page'
  | 'jira_issue'
  | 'github_pull_request'
  | 'github_issue'
  | 'github_doc';

export interface SourceAcl {
  /** True when every member of the source can read it. */
  open: boolean;
  /** Source ids of users and groups with read access, when the API gives them cheaply. */
  principals: string[];
  capturedAt: string;
}

export interface SourceContainer {
  externalId: string;
  kind: ContainerKind;
  name: string;
  url?: string;
  visibility: 'open' | 'restricted' | 'unknown';
  archived: boolean;
  acl?: SourceAcl;
}

export interface SourcePrincipal {
  externalId: string;
  kind: 'user' | 'bot' | 'group' | 'external';
  displayName: string;
  email?: string;
  login?: string; // GitHub
  active: boolean;
}

export interface DocumentSegment {
  /** Stable within the document: a message ts, a comment id, a heading path. */
  key: string;
  headingPath?: string[];
  authorExternalId?: string;
  at?: string;
  url?: string;
  text: string;
}

export interface KnowledgeDocumentInput {
  externalId: string;
  kind: DocumentKind;
  title: string;
  url: string;
  segments: DocumentSegment[];
  /** Opaque. Equal to the stored value means the content is unchanged. */
  sourceVersion: string;
  sourceCreatedAt: string;
  sourceUpdatedAt: string;
  authorExternalId?: string;
  participantExternalIds: string[];
  state?: 'open' | 'closed' | 'merged' | 'resolved' | 'archived';
  /** Source-specific, typed per kind in @shipit-ai/knowledge (status, labels, links, …). */
  attributes: Record<string, unknown>;
  /** True when the item carries its own restriction. Segments must then be empty. */
  restricted: boolean;
  acl?: SourceAcl;
}

export interface ChangeBatch {
  documents: KnowledgeDocumentInput[];
  deletedExternalIds: string[];
  /** Opaque; stored in the same transaction as the batch. */
  checkpoint: string;
}

export interface KnowledgeConnector {
  readonly manifest: ConnectorManifest;
  authenticate(config: ConnectorConfig): Promise<AuthResult>;
  listContainers(): AsyncIterable<SourceContainer>;
  listPrincipals(): AsyncIterable<SourcePrincipal>;
  /** Changes since the checkpoint, oldest first. A null checkpoint starts the backfill. */
  fetchChanges(
    container: SourceContainer,
    checkpoint: string | null,
    options: { historyDays: number },
  ): AsyncIterable<ChangeBatch>;
  /** Every external id that currently exists in the container. Drives pruning. */
  listDocumentIds(container: SourceContainer): AsyncIterable<string[]>;
  /** Source-specific edit and deletion detection beyond listDocumentIds (Slack). */
  reconcile?(container: SourceContainer, options: { days: number }): AsyncIterable<ChangeBatch>;
}

export interface KnowledgeSink {
  upsertContainers(containers: SourceContainer[]): Promise<void>;
  upsertPrincipals(principals: SourcePrincipal[]): Promise<void>;
  selectedContainers(): Promise<Array<SourceContainer & { checkpoint: string | null }>>;
  storeBatch(container: SourceContainer, batch: ChangeBatch): Promise<{ changed: number }>;
  pruneMissing(container: SourceContainer, presentIds: AsyncIterable<string[]>): Promise<number>;
}
```

`KnowledgeHarness` drives two run modes:

- **`poll`.** Authenticate. For each selected container, iterate `fetchChanges` from the
  stored checkpoint and hand each batch to `storeBatch`. Stop when a time budget
  (`knowledge.sync.maxRunMinutes`, default 10) is spent; the next run resumes from the
  checkpoint. A backfill is a poll from a null checkpoint and simply spans several runs.
- **`reconcile`.** Refresh the container list and the principals. For each selected
  container, run `reconcile` when the connector has one, then `listDocumentIds` and
  `pruneMissing`.

Amendments from the K0 audit (2026-10-04); the code in
`packages/connector-sdk/src/knowledge/types.ts` is the contract:

- `fetchChanges`, `reconcile` and `listDocumentIds` receive `signal` (aborted at shutdown)
  and `deadline` (when the run's budget ends), so a connector told to wait past the
  budget can end its iteration instead.
- A connector may declare `prunableKinds`: the kinds its id listing covers. Only those are
  pruned; an empty array means no listing and no prune. GitHub declares
  `['github_issue']`.
- A `ChangeBatch` may carry `notes`: things an admin should see that are not failures.
  They land on the run record and the run stays successful.
- `selectedContainers(mode)` returns the container a run of that mode visited longest ago
  first, and `markVisited` stamps every finished container, changes or not, so a run that
  spends its budget is followed by one that starts where it stopped.
- One empty id listing over a populated container prunes nothing; a second consecutive
  one is believed. A container emptied at the source is therefore cleared at the second
  reconcile, two days at most.
- A listing the budget cuts short prunes nothing and the container is retried first.

The SDK stays free of storage: `KnowledgeSink` is an interface, implemented with Postgres
in `@shipit-ai/knowledge`, the same way `EventBusClient` is implemented outside the SDK.

A connector error on one container is recorded and the run continues with the next. A
401 or 403 from `authenticate`, or from any call, sets `authFailed`, which the scheduler
maps to `degraded` exactly as it does today.

## Scheduling

`ConnectorType` in `services/connector-types/types.ts` changes shape:

- `build` becomes optional (absent for a knowledge-only type).
- New optional `buildKnowledge(cfg, ctx): Promise<KnowledgeBuildResult>`.
- A type must have at least one. GitHub has both; Slack, Confluence and Jira have only
  `buildKnowledge`; Kubernetes has only `build`.

A new `KnowledgeSyncScheduler` in api-server owns a separate queue,
`shipit-knowledge-sync`, so a long backfill never delays a graph sync. It uses BullMQ Job
Schedulers (`upsertJobScheduler`), per the agents spec's note that new scheduling code
should; ids are `knowledge~<connectorId>~poll` and `knowledge~<connectorId>~reconcile`
(no colons, per the scar). The existing `SyncScheduler` skips types without `build`.

| Job         | Default schedule                            | Does                              |
| ----------- | ------------------------------------------- | --------------------------------- |
| `poll`      | the connector's `schedule`, default 15 min  | `KnowledgeHarness` poll mode      |
| `reconcile` | `knowledge.sync.reconcileCron`, `0 3 * * *` | `KnowledgeHarness` reconcile mode |

Worker concurrency is 2. One job per connector runs at a time (job id carries the
connector id). Jobs carry the connector id and mode only. The queue gets the bounded
retention and the error listeners the existing queue has
(`apiserver-crashloop-unhandled-bullmq-error-on-oom-redis`).

Runs are recorded through `registry.recordRun` with a new `facet: 'knowledge'` field and
`entitiesSynced` counting documents. The Connector Hub shows them in the existing run
history. The scheduler does nothing when the knowledge layer is unavailable (§Feature
gating).

## Data model

All ids are UUIDs generated by the app, timestamps are `timestamptz`, JSON is `jsonb`,
following the agents spec. Tables are prefixed `knowledge_`.

| Table                         | Purpose and key columns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `knowledge_containers`        | `id`, `connector_id`, `external_id` (unique with `connector_id`), `kind`, `name`, `url`, `visibility`, `archived`, `acl`, `selected`, `selected_by`, `selected_at`, `visibility_acknowledged_by` (nullable), `mapped_entity_ids` (text[]), `checkpoint`, `backfill_done`, `oldest_fetched_at`, `last_polled_at`, `last_reconciled_at`, `purge_requested_at`, `gone_at`.                                                                                                                                                                                                                          |
| `knowledge_principals`        | `id`, `connector_id`, `external_id` (unique with `connector_id`), `kind`, `display_name`, `email`, `login`, `active`, `person_id` (graph canonical id, nullable), `match_method` (`email` \| `login` \| `manual`), `matched_at`.                                                                                                                                                                                                                                                                                                                                                                 |
| `knowledge_documents`         | `id`, `connector_id`, `container_id`, `external_id` (unique with `connector_id`), `kind`, `title`, `url`, `segments`, `content_hash`, `source_version`, `source_created_at`, `source_updated_at`, `author_principal_id`, `participant_principal_ids` (uuid[]), `state`, `attributes`, `restricted`, `acl`, `redactions` (int), `index_status` (`pending` \| `indexing` \| `indexed` \| `failed` \| `skipped`), `index_claimed_at`, `index_attempts`, `index_error`, `indexed_hash`, `index_version`, `extraction_status` (`none` \| `pending` \| `done` \| `skipped`), `deleted_at`, timestamps. |
| `knowledge_chunks`            | `id`, `document_id` (FK, cascade), `seq` (unique with `document_id`), `segment_keys` (text[]), `url`, `at`, `prefix`, `text`, `text_hash`, `token_estimate`, `tsv` (generated `tsvector` over `prefix` and `text`), `embedding halfvec(768)`, `embedding_model`.                                                                                                                                                                                                                                                                                                                                 |
| `knowledge_entity_links`      | `document_id` (FK, cascade), `entity_id`, `method` (PK with the other two), `entity_label`, `confidence`, `evidence`, `dictionary_version`.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `knowledge_document_refs`     | `from_document_id` (FK, cascade), `ref_kind` (`jira_key` \| `github_url` \| `confluence_url` \| `slack_url`), `ref_value` (PK with the other two), `to_document_id` (nullable until the target is indexed).                                                                                                                                                                                                                                                                                                                                                                                      |
| `knowledge_relation_mentions` | `document_id` (FK, cascade), `from_entity_id`, `relation_type`, `to_entity_id` (PK with the other three), `quote`, `confidence`, `model`. Written only by the opt-in extraction pass.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `knowledge_suggestions`       | `id`, `kind` (`identity` \| `container_mapping` \| `relation`), `dedupe_key` (unique), `payload`, `confidence`, `support_count`, `evidence`, `generator`, `status` (`pending` \| `accepted` \| `rejected` \| `superseded`), `decided_by`, `decided_at`, `reason`, `applied_ref`, timestamps.                                                                                                                                                                                                                                                                                                     |
| `knowledge_state`             | `key` (PK), `value`. Small singletons: the alias dictionary version and hash, the extraction token counter for the day, the last run time of each generator.                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Indexes: `knowledge_chunks` HNSW on `embedding` (`halfvec_cosine_ops`) and GIN on `tsv`;
`knowledge_documents (index_status, index_claimed_at)` partial on the non-terminal states,
`(container_id, source_updated_at desc)`, `(kind, state, source_updated_at desc)`, GIN on
`participant_principal_ids`; `knowledge_entity_links (entity_id, confidence)`;
`knowledge_document_refs (ref_kind, ref_value)`; `knowledge_suggestions (status, kind)`.

**A deleted document** keeps its row as a tombstone with `segments`, `title`, `attributes`
and participants cleared and `deleted_at` set; its chunks, links, references and relation
mentions are removed in the same transaction. Tombstones are removed after
`knowledge.retention.tombstoneDays` (default 30).

**A restricted document** (§Visibility) is stored the same way a tombstone is: a row with
no content, `restricted: true`, `index_status: 'skipped'`. It exists so the reconcile pass
does not refetch it every run and so the UI can count what was excluded.

**Schema handshake.** `@shipit-ai/knowledge` exports the list of migration versions it
needs. At boot each process checks that all of them are present in `schema_migrations` and
that `pg_extension` contains `vector`. A missing version or extension disables the
knowledge layer with a clear status; nothing crashes. This checks for presence, not for a
maximum, because two workstreams share one migration sequence.

**The first knowledge migration** begins by raising a clear error when the `vector`
extension is absent, so a deploy on an instance that was not bootstrapped fails with the
reason and not with "type halfvec does not exist".

## Sources

Shared rules:

- External ids are the source's stable ids, never names.
- Text is normalised to plain text with light Markdown. User and channel mentions are
  replaced by display names. Code blocks are kept.
- A document over `knowledge.index.maxDocumentChars` (default 400,000) is truncated at a
  segment boundary and flagged in `attributes.truncated`.
- Every call honours `Retry-After`. A 429 pauses that connector's job; it does not fail
  the run.
- `historyDays` bounds the backfill per connector. `0` means everything.

### GitHub text

A facet of the existing GitHub connector. The instance config gains:

```yaml
knowledge:
  enabled: false
  pullRequests: true
  issues: true
  docs:
    enabled: true
    paths: ['README.md', 'docs/**/*.md', 'adr/**/*.md', '**/ADR-*.md']
    maxFileBytes: 200000
  historyDays: 365
```

- **Containers:** the repositories in the connector's scope. Public and internal
  repositories are `open`; private ones are `restricted`.
- **Pull requests:** one document per pull request: title, body, state, labels, author,
  then issue comments, reviews and review comments as segments. Fetched with GraphQL
  ordered by `UPDATED_AT`, stopping at the checkpoint. `sourceVersion` is `updatedAt`.
- **Issues:** the same shape, kind `github_issue`.
- **Docs:** one document per matching Markdown file on the default branch, split into
  segments by heading. The repository's tree is listed once per run; an unchanged tree sha
  skips the repository; `sourceVersion` is the blob sha. A file that leaves the tree is
  deleted in the same run, so docs need no separate prune.
- **Deletion:** pull requests cannot be deleted. Issues can; `listDocumentIds` covers them.
- **Auth:** the connector App's installation token, minted as the graph connector does.

**The permission change.** The App manifest gains `issues: read` and the `issues` and
`issue_comment` events. The manifest only shapes Apps created after the change. For an
App that already exists, its owner adds the permission in the App's settings, and each
installation then approves the request. Until that happens the issues fetch gets a 403.
The facet treats that as a note (`issues_permission_missing`), not a failure: pull
requests and docs keep syncing, and the connector detail shows a banner with the steps and
a link to the App's permission page. Whether a permission can be added to a
manifest-created App without recreating it is checked in the K1 spike; the banner text
depends on the answer.

### Jira

- **Auth:** an Atlassian service account with a scoped API token, sent as Basic auth
  (account email and token) to `https://api.atlassian.com/ex/jira/<cloudId>`. The wizard
  takes the site URL, the account email and the token, and resolves the cloud id. Token
  traffic is governed by burst limits, not by the points quotas that apply to OAuth and
  Forge apps. The token's expiry date is stored; the connector reports `degraded` 14 days
  before it and the Hub shows a rotation prompt.
- **Containers:** projects. Visibility is `unknown`: reading permission schemes needs Jira
  administration rights the service account should not have.
- **Documents:** one per issue. First segment: summary, key, type, status, priority,
  labels, components, fix versions, parent, description. Then one segment per comment.
  Bodies are Atlassian Document Format, converted by the shared walker. A comment that
  carries a visibility restriction is skipped. `attributes` holds the structured fields
  and the issue links.
- **Poll:** `POST /rest/api/3/search/jql` with
  `project = <id> AND updated >= <checkpoint minus one hour> ORDER BY updated ASC`, token
  pagination, then `POST /rest/api/3/issue/bulkfetch` for the bodies. Comments beyond the
  first page are fetched per issue. `sourceVersion` is `updated`.
- **Restricted items:** an issue with a security level is stored as a restricted stub.
- **Deletion:** Jira leaves no tombstone. `listDocumentIds` lists the project's issue ids
  daily and the sink prunes the rest.
- **Linked pull requests:** Jira has no supported API for them. `knowledge_document_refs`
  recovers the links from pull request and issue text that mentions an issue key.
- **External id:** the numeric issue id, which survives a move between projects. The key
  lives in `attributes.key`.

### Confluence

- **Auth:** the same service account and token, against
  `https://api.atlassian.com/ex/confluence/<cloudId>`. The Atlassian wizard can create
  both instances from one credential entry.
- **Containers:** spaces (REST v2). Visibility comes from the space's permissions: `open`
  when a group covering all licensed users can read it, otherwise `restricted`. Personal
  spaces are hidden.
- **Documents:** one per page or blog post. Segments follow the heading structure of the
  body, then footer and inline comments. The body is requested as `atlas_doc_format` so
  the Jira walker is reused; the K3 spike confirms this beats converting `storage` format.
- **Poll:** REST v2 has no modified-since filter, so the v1 search endpoint is used with
  CQL `space = <key> AND type in (page, blogpost) AND lastmodified >= <checkpoint minus one
day>`. CQL dates have minute resolution and are read in the account's time zone; the
  one-day overlap covers both, and an unchanged version number skips the page.
  `sourceVersion` is the version number.
- **Restricted items:** a page with a read restriction of its own, or one inherited from
  an ancestor, is stored as a restricted stub. Inheritance is not documented, so the
  connector walks the ancestors. It fails closed: a page whose restrictions cannot be
  established is treated as restricted.
- **Deletion:** the reconcile pass lists `trashed` and `archived` pages, then prunes by id.
  Trashed pages are deleted. Archived pages are kept with `state: 'archived'`.
- **No webhooks.** Confluence offers them only to Forge and Connect apps.

### Slack

- **App:** each customer creates their own Slack app from a manifest we supply. The wizard
  opens `https://api.slack.com/apps?new_app=1&manifest_json=…`, the admin installs the app
  to the workspace and pastes the bot token, and a probe (`auth.test`) confirms the
  workspace and the granted scopes.
- **Scopes:** `channels:read`, `channels:history`, `channels:join`, `users:read`,
  `users:read.email`, `usergroups:read`, `team:read`. No events, no Socket Mode, no user
  token.
- **Containers:** public channels that are not shared through Slack Connect. Private
  channels, direct messages and shared channels are not listed. Selecting a channel makes
  the bot join it (`conversations.join`).
- **Documents:**
  - **`slack_thread`** — a message with replies. External id `<channel>/<thread_ts>`. One
    segment per message.
  - **`slack_channel_day`** — the channel's un-threaded messages for one UTC day. External
    id `<channel>/d/<yyyy-mm-dd>`. One segment per message. Day buckets give stable ids;
    the chunker splits a day where the conversation pauses. A message that later gains a
    reply moves out of its day document into its own thread, and the day is rebuilt.
  - Join, leave and other system messages are dropped. Bot messages are kept, because
    alert and deploy bots carry operational history; `includeBots: false` turns them off.
  - Each segment carries the message permalink, so a citation opens the exact message.
- **Poll:** `conversations.history` from the checkpoint minus one hour; every day touched
  is refetched whole; every parent whose reply count or latest reply changed is refetched
  with `conversations.replies`.
- **Reconcile:** daily, the last `rescanDays` (default 14) of each channel are refetched,
  which catches edits, deletions and late replies. Weekly, the full message-id list of
  each channel is walked and documents whose messages are gone are deleted. Whether a
  workspace retention purge emits anything is unverified; this pass covers it either way.
- **Rate limits:** a customer-created internal app keeps Tier 3 on both history methods.
  Thread fetches are the bottleneck, at one call per thread.
- **Defaults:** `historyDays: 365`.
- **Identity:** `users.list` gives the email, and flags bots, guests and deactivated
  accounts.

## Visibility

The source credential's reach is the outer boundary: the Slack bot sees public channels,
and the Atlassian service account sees what its org admin granted it. The admin's
selection is the inner boundary. Nothing outside both is fetched.

| Case                                                         | v1 behaviour                                                                                                                             |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Container with `visibility: 'open'`                          | Selectable.                                                                                                                              |
| Container that is `restricted` or `unknown`                  | Selectable only with an explicit acknowledgement that every logged-in ShipIt user will see its content. Who acknowledged it is recorded. |
| Slack private channel, direct message, Slack Connect channel | Never listed.                                                                                                                            |
| Restricted Confluence page, Jira issue with a security level | Stored as a stub with no content.                                                                                                        |
| Restricted Jira comment                                      | Skipped.                                                                                                                                 |

**What is recorded for later.** Each container and each document stores an `acl` when the
source provides one cheaply, with the time it was captured. Every query in
`@shipit-ai/knowledge` passes through one function, `visibilityPredicate(ctx)`, which
returns `TRUE` in v1. Permission mirroring later adds a permission-sync job and a real
predicate; no table changes and no re-ingest. The recorded ACLs are a snapshot. They are
not kept fresh in v1 and must not be used for filtering until the sync job exists.

**Who may configure.** Creating, updating and deleting a knowledge connector, changing a
container selection and deciding a suggestion require an admin. `routes/connectors.ts`
has no role gate today (a side finding of the agents deep dive); this work adds one for
all connector mutations, because a member who can add a Slack connector can publish a
channel to the whole installation.

## Index pipeline

The worker claims work straight from Postgres:

```sql
UPDATE knowledge_documents SET index_status = 'indexing', index_claimed_at = now()
WHERE id IN (
  SELECT id FROM knowledge_documents
  WHERE index_status = 'pending'
     OR (index_status = 'indexing' AND index_claimed_at < now() - interval '10 minutes')
  ORDER BY updated_at LIMIT $1 FOR UPDATE SKIP LOCKED
) RETURNING id;
```

It wakes on a Redis pub/sub message (`shipit-knowledge-wake`, sent by the sink after a
batch commits) and otherwise every 10 seconds. A lost wake-up costs at most that delay.
The stale-claim clause recovers documents a crashed worker left behind.

For each document:

1. **Skip** when `restricted`, deleted or empty. When `content_hash` equals
   `indexed_hash` and `index_version` is current, only the links are refreshed.
2. **Chunk** (below).
3. **Embed** every chunk whose `text_hash` does not match a chunk the document already
   has. A thread that gained one reply re-embeds one chunk. `text_hash` covers the prefix
   and the text, because both are embedded: a rename re-embeds, and the same text under
   two headings gets two vectors.
4. **Link** entities and references (§Entity linking).
5. **Commit** in one transaction: replace the chunks, links and references, set
   `indexed_hash` and `index_status = 'indexed'`.

A failure sets `index_status = 'failed'` with the error and increments `index_attempts`.
Failed documents are retried with backoff up to 5 attempts and then left for the status
page.

**Chunking.** Tokens are estimated at four characters each. Target 600 tokens, maximum 800. A chunk never splits a segment unless that segment alone exceeds the maximum.

| Kind                  | Chunks                                                                               | Prefix                                       |
| --------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------- |
| Pages and docs        | Consecutive segments under one heading path, packed to the target.                   | Title and heading path.                      |
| Issues, pull requests | A header chunk (title, key, state, labels, description), then comment windows.       | Key or number, title, repository or project. |
| Slack thread          | The whole thread when it fits; otherwise message windows overlapping by one message. | Channel, date, the first line of the thread. |
| Slack channel day     | Split where the gap between messages exceeds 10 minutes, then packed to the target.  | Channel and date.                            |

Each message line reads `Name (HH:MM): text`. The prefix is embedded and indexed with the
text, which gives each chunk its context without a model call.

**Embedding.** `gemini-embedding-2` through `@ai-sdk/google-vertex`, 768 dimensions,
`taskType: 'RETRIEVAL_DOCUMENT'` for chunks and `'RETRIEVAL_QUERY'` for queries, the
document title passed as `title`. The provider sends this model one value per call, so
the worker runs `knowledge.worker.concurrency` calls in parallel (default 8) and retries
429 and 5xx with backoff. `embedding_model` is stored on every chunk. Changing the model
or the dimension is a new migration plus a full re-embed.

**`index_version`** is a constant in `@shipit-ai/knowledge`. Raising it (a chunker change)
marks every document `pending` through an admin action, never automatically at boot.

## Entity linking

The worker builds an **alias dictionary** from Neo4j: for each node of the labels in
`knowledge.linking.labels` (default `LogicalService`, `Repository`, `Team`), its name,
slug, full name (`org/repo`) and URL. Absent nodes and `_`-prefixed labels are excluded.
The dictionary is rebuilt every 10 minutes; its hash is the `dictionary_version`.

| Tier | Signal                                                                                                                                  | Method      | Confidence |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------- | ---------- |
| 1    | The document belongs to a repository (pull request, issue, doc).                                                                        | `structure` | 1.0        |
| 1    | A URL in the text resolves to an entity (a GitHub repository URL, a ShipIt catalog URL).                                                | `url`       | 1.0        |
| 2    | The services a linked repository implements (`IMPLEMENTED_BY`).                                                                         | `structure` | 0.9        |
| 2    | A qualified key: `org/repo` in text, or a Jira component or label equal to an entity's name or slug.                                    | `key`       | 0.9        |
| 3    | An exact name or slug on a token boundary, unique in the graph, at least 4 characters, not on the stop list.                            | `alias`     | 0.7        |
| 4    | The container is mapped to the entity (`mapped_entity_ids`).                                                                            | `container` | 0.6        |
| 5    | A short, common or non-unique name, kept only when the document also has a tier 1 to 3 link to a neighbour of that entity in the graph. | `alias`     | 0.5        |

Matching is one Aho-Corasick pass per document over the lowercased text. Nothing below 0.5
is stored. The stop list (`api`, `web`, `app`, `core`, `test` and similar) lives in config.

**References.** Jira keys (`[A-Z][A-Z0-9]+-\d+`, checked against the known project keys)
and URLs of GitHub pull requests and issues, Confluence pages and Slack messages are stored
in `knowledge_document_refs` and resolved to documents once both ends are indexed.

**Relinking.** When the dictionary changes, links for removed entities are deleted, and
for each added alias the full-text index finds the candidate documents, which are relinked.
A full relink is an admin action. Linking never calls a model.

**People.** Documents reference principals, not `Person` nodes. A principal is matched to
a `Person` by, in order: the same email as the node's `email` property, compared
case-insensitively; for GitHub, `buildPersonCanonicalId(login)` when that node exists.
Atlassian hides emails by default, so many Atlassian principals stay unmatched until an
identity suggestion is accepted.

## Suggestions

A suggestion is the only way ingested content changes the graph or the linking rules.

| Kind                | Generator (hourly, SQL)                                                                                                                                                                        | Accepting it                                                                                |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `identity`          | An unmatched principal whose display name matches exactly one `Person` name at Jaro-Winkler 0.92 or above.                                                                                     | Sets `person_id` with `match_method: 'manual'`. Postgres only.                              |
| `container_mapping` | A container with at least `minSupport` linked documents where 60% or more link to the same `Team` or `LogicalService`; or a container name that matches an entity name.                        | Adds the entity to `mapped_entity_ids`; the relinker applies it. Postgres only.             |
| `relation`          | (a) A matched `Person` who authored at least `minSupport` merged pull requests in a repository in 180 days and has no `CONTRIBUTES_TO` edge. (b) Aggregated relation mentions from extraction. | `RelationEditService.addRelation` as the accepting user. The one path that writes to Neo4j. |

Rules:

- `dedupe_key` is the kind plus the proposed subject, relation and object. A pending
  suggestion is updated in place as evidence grows. A rejected one never comes back unless
  an admin reopens it.
- A relation that appears in the graph by any other route marks its suggestion
  `superseded`.
- Accepting a relation goes through the existing route, so the `graph:write` capability,
  the manual-write kill switch, the schema allow-list and the `GraphEditEvent` audit all
  apply. The audit event records the suggestion id. The edge is the accepting person's
  manual edge: they vouched for it.
- Each suggestion shows its evidence: up to five documents with the quoted passage and a
  link to the source.
- `minSupport` defaults to 3.

**Relation extraction (opt-in).** With `knowledge.suggestions.extraction.enabled`, the
worker makes one structured model call for each newly indexed page, doc, pull request or
issue that links at least two entities. The model receives the text, the numbered list of
entities already linked to that document, and the relationship types the schema allows
between their labels. It returns relations between list numbers, each with a quotation.
The worker drops any relation whose quotation is not found verbatim in the document or
whose type the schema does not allow for those labels. Survivors go to
`knowledge_relation_mentions`; a relation mentioned by `minSupport` different documents
becomes a suggestion. The model cannot name an entity that is not on the list, so it
cannot invent a node. A daily token cap (`extraction.dailyTokens`) stops the pass when
spent.

## Retrieval

`search(query, filters, options)` in `@shipit-ai/knowledge`:

1. Embed the query.
2. **Vector leg:** the 50 nearest chunks by cosine distance, with
   `hnsw.iterative_scan = relaxed_order` so filters do not starve the result.
3. **Keyword leg:** `websearch_to_tsquery('english', query)` against `tsv`, top 50 by
   `ts_rank_cd`.
4. **Entity leg:** the query is run through the linker; when it names entities, the 50
   nearest chunks among documents linked to them.
5. **Fuse** with reciprocal rank fusion (`1 / (60 + rank)`, summed over legs).
6. **Collapse** to documents, at most two chunks each, and return the top `limit`.

Filters: `connectors`, `kinds`, `entityIds`, `containerIds`, `authorPersonIds`, `state`,
`updatedAfter`, `updatedBefore`. Every query includes `visibilityPredicate(ctx)` and
excludes deleted and restricted documents.

Search is defined against an interface, `KnowledgeSearchBackend`, with one implementation
(`PostgresSearchBackend`). A live backend for one source, such as Slack's Real-time Search
API, can be added behind it and fused as a further leg. That is the swap seam of decision 5.

Without an embedder the function runs the keyword and entity-filter legs only. That is
what the api-server keyword search route uses.

## Tools

Five tools in the agents catalog under service `knowledge`, all with effect `read`:

| Tool                        | Input                                                                | Returns                                                                                                             |
| --------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `knowledge.search`          | `query`, filters, `limit` (default 8, max 25)                        | Documents with snippets, source, title, URL, author, dates, state and linked entities.                              |
| `knowledge.get_document`    | `document_id`, `max_chars`                                           | The full text as segments, the attributes, linked entities and references.                                          |
| `knowledge.entity_timeline` | `entity_id`, `kinds`, `from`, `to`, `include_related` (default true) | Documents linked to the entity at 0.6 or above, newest first. With `include_related`, also its repositories' items. |
| `knowledge.find_experts`    | `query` or `entity_id`, `since`                                      | Up to 10 people ranked by authorship and participation, each with counts and three evidence documents.              |
| `knowledge.work_items`      | `entity_id` or `container_id`, `state`, `kinds`, `assignee`, `limit` | Issues and pull requests with their structured fields, most recently updated first.                                 |

`find_experts` scores a person as the sum, over matching documents, of a role weight
(author 1.0, participant 0.4) times the document's relevance times a recency decay with a
180-day half-life. An unmatched principal is returned by display name and source.

Results are JSON. Every result carries its source, author and URL, and the payload starts
with a fixed notice that the content is retrieved data and not instructions. Snippets are
capped (`knowledge.search.resultChars`, default 1,500 per document), and the agents
`toolResultChars` limit applies on top. Each result includes a `citations` array that Ask
renders with the `Citation` component.

The executors run in the agent runner and call `@shipit-ai/knowledge` in-process with the
runner's Postgres pool, its Vertex client and its read-only Neo4j session (for
`include_related` and query linking). When the knowledge layer is unavailable the tools
resolve to `off` and are not sent to the model.

## Changes requested of the agents spec

1. **Catalog.** The built-in tool catalog gains service `knowledge` with the five tools.
   The permission matrix shows it as a row with only the Read column.
2. **Gateway ceiling 5.** Once a run has a succeeded `tool_calls` row with service
   `knowledge`, `allow` becomes `ask` for `write` and `delete` for the rest of that run.
   A child run inherits it from its parent. It is derived from existing rows, so it needs
   no new column and survives a crash and resume. `knowledge.agents.askWritesAfterRead`
   (default true) turns it off.
3. **Built-in assistant.** The Graph assistant seed grants `knowledge` read `allow`.
4. **Postgres foundation.** The instance becomes a pgvector instance on Postgres 17
   (§Infra), and migration numbers are allocated when a branch merges, not when it is
   written: the later branch renumbers.

## API

All routes are behind `require-auth`. Mutations require an admin.

| Route                                                                      | Purpose                                                                                            |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GET /api/knowledge/status`                                                | §Feature gating, plus counts: documents, indexed, pending, failed, restricted, chunks.             |
| `POST /api/connectors/slack/probe`, `/atlassian/probe`                     | Validate credentials before saving. Same shape as the Kubernetes probe.                            |
| `POST /api/connectors/slack/credentials`, `/atlassian/credentials`         | Store credential files in the key dir, mirrored to the `connector-apps` blob like Kubernetes.      |
| `GET /api/connectors/:id/containers`                                       | List with search, visibility, selection, document counts and backfill progress.                    |
| `POST /api/connectors/:id/containers/refresh`                              | Run the container listing now.                                                                     |
| `PUT /api/connectors/:id/containers/:containerId`                          | Set `selected`, `mapped_entity_ids`, the visibility acknowledgement. Deselecting requests a purge. |
| `GET /api/knowledge/search?q=`                                             | Keyword search for the UI.                                                                         |
| `GET /api/knowledge/documents/:id`                                         | One document with segments, links and references.                                                  |
| `GET /api/knowledge/entities/:entityId/timeline`                           | The entity page's Knowledge tab.                                                                   |
| `GET /api/knowledge/suggestions`, `POST …/:id/accept`, `POST …/:id/reject` | The inbox. Accept needs `graph:write` for relations.                                               |
| `POST /api/knowledge/admin/reindex`, `/relink`                             | Mark documents pending after an `index_version` change; run a full relink.                         |

Deleting a knowledge connector sets `purge_requested_at` on its containers; the worker
deletes the content and then the rows.

## Config

A new top-level `knowledge` section in the shared schema, all optional with defaults:

```yaml
knowledge:
  enabled: true # master switch; false hides the feature without touching data
  embedding: { model: gemini-embedding-2, dimensions: 768 }
  sync: { maxRunMinutes: 10, reconcileCron: '0 3 * * *' }
  worker: { concurrency: 8, batchSize: 16 }
  index: { maxDocumentChars: 400000, chunkTokens: 600, maxChunkTokens: 800 }
  linking: { labels: [LogicalService, Repository, Team], stopList: [] }
  search: { defaultLimit: 8, maxLimit: 25, candidatesPerLeg: 50, resultChars: 1500 }
  suggestions:
    enabled: true
    minSupport: 3
    extraction: { enabled: false, model: '', dailyTokens: 2000000 }
  agents: { askWritesAfterRead: true }
  retention: { tombstoneDays: 30 }
```

The Vertex project and location come from `ai.vertex`. `dimensions` must match the column
type; a mismatch disables indexing with a clear status.

Connector instances for `slack`, `confluence` and `jira` join `connectorInstanceSchema`
with `id`, `name`, `enabled`, `schedule`, the non-secret identity of the source (workspace
id and name; site URL, cloud id and account email), a credential file reference, the
token's expiry date for Atlassian, and `historyDays`. Container selection lives in
Postgres, not in the instance, because it is large and changes often.

## Secrets

| Secret                              | Storage                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| Slack bot token                     | A credential file in the key dir, mirrored into the `connector-apps` GSM blob, like a kubeconfig. |
| Atlassian API token                 | The same.                                                                                         |
| GitHub                              | Nothing new; the connector App's existing credentials.                                            |
| `DATABASE_URL` for knowledge-worker | ESO env, the `shipit_app` role, as for api-server and the runner.                                 |

Tokens are a few hundred bytes each, well inside the blob's 64KB cap for the number of
connectors it already bounds. No new secret container is needed. Tokens never appear in
API responses, logs or documents.

## Web UI

- **Connector picker.** Slack and Atlassian join GitHub and Kubernetes, tagged
  "Knowledge". When the knowledge layer is unavailable they are disabled with the failing
  check named.
- **Slack wizard.** Create the app from the manifest link, paste the bot token, probe,
  pick channels.
- **Atlassian wizard.** Site URL, service-account email, API token and its expiry date,
  choose Confluence, Jira or both, probe, pick spaces and projects.
- **GitHub connector detail.** A Knowledge section: enable, choose pull requests, issues
  and docs, pick repositories, and the issues-permission banner when needed.
- **Container picker.** Searchable list with a visibility badge, document count and
  backfill progress. Selecting a `restricted` or `unknown` container opens the
  acknowledgement dialog. Deselecting warns that the content will be deleted.
- **Connector detail drawer.** Documents fetched, indexed, pending, failed and excluded as
  restricted; last poll and last reconcile; the token expiry warning. Status renders only
  through `CONNECTOR_STATUS`, per the scar.
- **Entity page** (`/catalog/[id]`). A Knowledge tab: the timeline of linked documents,
  filterable by source and kind, each opening the source.
- **Suggestions inbox** (`/operations/suggestions`), beside Reconciliation and Claims.
  Cards grouped by kind with the proposal, confidence, support count and evidence, and
  Accept and Reject with an optional reason. The nav entry shows the pending count.
- **Ask.** Citations under each answer; tool calls for `knowledge.*` render in
  `ToolCallCard` like any other.
- **Keyword search.** The global command palette (`global-command-palette.tsx`) gains a
  Knowledge group fed by `GET /api/knowledge/search`.

## Feature gating

`GET /api/knowledge/status` reports each prerequisite and an overall `available`:

| Check       | Unavailable when                                                          |
| ----------- | ------------------------------------------------------------------------- |
| `enabled`   | `knowledge.enabled` is false                                              |
| `database`  | `DATABASE_URL` unset or unreachable                                       |
| `schema`    | a required migration version is missing from `schema_migrations`          |
| `extension` | `pg_extension` has no `vector`                                            |
| `embedding` | `ai.vertex.project` empty, or `knowledge.embedding.dimensions` is not 768 |
| `worker`    | no heartbeat (`shipit-knowledge-worker-heartbeat`, every 15s, 60s TTL)    |

The status has two levels. `ingestionAvailable` needs `enabled`, `database`, `schema` and
`extension`; `available` needs all six. Sync jobs fetch and store while `ingestionAvailable`
holds, so a dead worker or an unconfigured Vertex project never stops ingestion: documents
wait as `pending` and the worker catches up when it returns (K0 ruling, 2026-10-04; the
earlier text said sync jobs stop when anything is unavailable). When `ingestionAvailable`
is false, knowledge routes return `503 KNOWLEDGE_UNAVAILABLE` with the failing checks and
sync jobs do not run. When `available` is false the `knowledge.*` tools resolve to `off`.
The rest of the product is unaffected either way. api-server never exits because a
knowledge prerequisite is missing; `knowledge-worker` exits non-zero when the database,
schema, extension or Vertex project is missing, so the Deployment restarts it after the
migration step (the core-writer precedent), and idles when `knowledge.enabled` is false.
The agents feature is not a prerequisite for ingestion: content can be indexed and browsed
on entity pages before any agent exists.

## Error handling

| Situation                                        | Behaviour                                                                                                 |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Source returns 429                               | Wait `Retry-After`, continue. If the wait exceeds the run budget, end the run; the checkpoint resumes it. |
| Source returns 401 or 403                        | `authFailed`; connector `degraded`; the Hub says the token was revoked or expired.                        |
| One container fails                              | Recorded in the run's errors; the run is `partial`; other containers continue.                            |
| Reconcile listing fails or is incomplete         | No pruning for that container in that run. An incomplete listing never deletes.                           |
| api-server restarts mid-backfill                 | The stalled job is redelivered and resumes from the last committed checkpoint.                            |
| Embedding call fails after retries               | The document is `failed`, retried with backoff up to 5 attempts.                                          |
| Worker crashes mid-document                      | The claim goes stale after 10 minutes and another loop takes the document.                                |
| Redis unavailable                                | The wake-up is lost; the worker's 10-second poll still finds the work. Sync jobs wait for Redis.          |
| Postgres unavailable                             | Sync jobs and the worker fail their current step and retry; status reports `database`.                    |
| Neo4j unavailable to the worker                  | The dictionary is not rebuilt; linking uses the last one; `include_related` returns the entity alone.     |
| An entity is deleted or goes absent in the graph | Its links are removed at the next dictionary rebuild.                                                     |
| GitHub issues permission not yet approved        | A note on the run and a banner; pull requests and docs continue.                                          |

## Safety

- **Prompt injection.** Ingested text is written by anyone who can post in a selected
  channel, comment on a page or open an issue. It reaches a model only as a tool result,
  wrapped as data with its source and author. The control that matters is structural:
  after a run reads knowledge content, every write and delete needs a person's approval
  (decision 15). Relation extraction is bounded the same way: the model can only choose
  among entities already linked, must quote the document, and its output is reviewed.
- **Secrets in content.** Every segment passes through the secretlint rule set before it
  is stored. A match is replaced with `[redacted:<rule>]` and counted on the document.
  Redaction happens in the sink, so neither Postgres nor Vertex sees the secret.
- **Data egress.** Document text is sent to Vertex AI in the owner's GCP project for
  embedding, and, when extraction is on, for relation extraction. The Connector Hub states
  this on every knowledge connector. With `knowledge.enabled: false` nothing is fetched
  and nothing leaves.
- **Over-sharing.** The curated model means an admin's selection publishes a container to
  every logged-in user. The acknowledgement dialog, the visibility badge, the exclusion of
  private Slack channels and the fail-closed handling of restricted pages are the guards.
- **Deletion.** Content deleted in the source is deleted here at the next reconcile, at
  most a day later. Copies inside agent run transcripts outlive it until the agents
  retention removes them (30 days by default); the Hub says so.
- **Outbound requests.** Source hosts are fixed per type (`slack.com`, `api.atlassian.com`
  and the validated `*.atlassian.net` site, `api.github.com`). The Atlassian site URL is
  validated against that pattern; no arbitrary host is ever called.
- **Redis.** Jobs carry a connector id and a mode. No content, no id lists.
- **Spend.** Embedding cost is bounded by what an admin selects and by `historyDays`.
  Extraction has its own daily cap. The infra budget alert on Vertex is the backstop.

## Legal

Two items need the owner's attention before any paid or hosted offering. Neither blocks a
free, self-hosted release.

1. **Slack.** Slack's API terms (effective 2025-10-10) restrict bulk export of message
   data for apps offered outside the developer's own organisation, and define commercial
   distribution to include giving customers "a custom Application or Application template"
   that connects to a paid product. A customer-created internal app indexing its own
   workspace for a free self-hosted product is not covered by that restriction. A paid
   tier that ships the same manifest may be. Marketplace apps may not copy messages at all.
   The retrieval seam (decision 5) is the technical hedge; the decision needs a legal read.
2. **Atlassian.** The Atlassian Developer Terms (effective 2025-12-01) forbid apps that
   "substantially replicate" Atlassian features (§6(f)). An enterprise-search product is
   close enough to Rovo that a hosted offering deserves a legal read.

Slack's developer policy also requires deleting a workspace's data within 14 business days
of the app being removed. Deleting the connector purges its content immediately, which
satisfies it; an operator who removes the Slack app without deleting the connector must
delete the connector too, and the Hub says so when the token starts failing.

## Testing

| Layer                              | Tests                                                                                                                                                                                                                                                                 |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connector-sdk` unit               | `KnowledgeHarness` with a fake connector and sink: resume from a checkpoint, time budget, one failing container, an incomplete listing never prunes, `authFailed`.                                                                                                    |
| connectors unit                    | Each connector against recorded API fixtures: container listing, backfill, incremental with overlap, restricted items become stubs, deletion detection, pagination, 429 handling. ADF walker over a fixture set. Slack day-bucket and thread-promotion cases.         |
| `knowledge` unit                   | Chunkers per kind (table-driven); redaction; alias dictionary and each linking tier, including the stop list and the tier 5 neighbour rule; reference extraction; rank fusion; `find_experts` scoring; suggestion dedupe and supersede rules.                         |
| `knowledge` integration (Postgres) | A fresh pgvector database gets every migration, then: sink upsert and tombstone, claim and stale-claim recovery, chunk replacement with embedding reuse, hybrid search with each filter, visibility predicate present in every query. Serial, per the shared-DB scar. |
| worker unit, fake embedder         | The index loop: success, embedding failure and retry, skip unchanged, crash recovery, relink on dictionary change, purge.                                                                                                                                             |
| extraction unit, fake model        | Quotation check, schema allow-list, candidate-only output, daily cap.                                                                                                                                                                                                 |
| api-server                         | Admin gates on every mutation; `KNOWLEDGE_UNAVAILABLE` for each failing check; container selection and acknowledgement; suggestion accept writes one edge and one audit event; reject is sticky; existing suites unchanged with `DATABASE_URL` unset.                 |
| agent-runner                       | The five executors against a seeded database; ceiling 5 turns `allow` into `ask` after a knowledge read and is inherited by a child run.                                                                                                                              |
| web-ui                             | Wizards, container picker and acknowledgement, permission banner, Knowledge tab, inbox, citations.                                                                                                                                                                    |
| retrieval evaluation               | A gold set of 50 to 100 questions over the portal-demo corpus with the documents that answer them; recall@20 is recorded per change. Not a CI gate; a number in each retrieval PR.                                                                                    |
| live, opt-in                       | Gated on sandbox credentials: one small workspace, site and repository per source. Not in CI.                                                                                                                                                                         |
| manual                             | The success criteria below on portal-demo.                                                                                                                                                                                                                            |

## Success criteria (v1 is done when)

On portal-demo, with Postgres 17 and pgvector, the worker and Vertex in place:

1. An admin adds Slack, Confluence and Jira from the Connector Hub and enables GitHub
   knowledge, selects containers, and watches each backfill complete.
2. Ask answers one question of each of the four kinds, citing documents from at least two
   different sources in one answer, on a Claude model and on a Gemini model.
3. A service's entity page shows a Knowledge tab with pull requests, issues, a page and a
   Slack thread that mention it.
4. A pull request that mentions a Jira key and the Jira issue reference each other.
5. Editing a Slack message, deleting a Confluence page and deleting a Jira issue are each
   reflected in the index within one reconcile cycle.
6. A private Slack channel never appears in the picker. A restricted Confluence page and a
   Jira issue with a security level are counted as excluded and return no content.
7. A pasted credential in a Slack message is stored and returned as `[redacted:…]`.
8. Selecting a `restricted` container requires the acknowledgement, and it is recorded.
9. The inbox shows an identity suggestion, a container mapping and a relation suggestion.
   Accepting the relation creates the edge with a `GraphEditEvent`; rejecting one keeps it
   from returning.
10. An agent with a GitHub write grant of `allow` reads knowledge content and then pauses
    for approval before its write.
11. Deleting the Slack connector removes every Slack document, chunk and principal.
12. An installation whose GitHub App lacks the issues permission syncs pull requests and
    docs and shows the banner; after approval, issues appear.
13. With `DATABASE_URL` unset, or the worker stopped, the product behaves as it does today
    and the knowledge connectors show what is missing.
14. CI is green with the new unit and integration suites, and `pnpm audit` is clean.

## Infra (cross-repo, `shipit-ai-infra`)

- **Brief, written:** `docs/agent/briefs/infra-pgvector-for-knowledge.md`. It amends the
  Postgres brief, which sits in the infra repo's inbox with no work started: a pgvector
  image on Postgres 17, a one-off
  superuser step that creates the `vector` extension, more memory and disk, and a KSA and
  GSA for the worker with the Vertex role.
- **Brief 2, at K0:** the `knowledge-worker` Deployment (no Service, `replicas: 1`), its
  image in `build-images.yml`, env (`DATABASE_URL`, Redis, Neo4j read-only, Vertex project
  and location), and egress from api-server to Slack and Atlassian.
- **Operator steps:** create the Slack app from the manifest; create the Atlassian service
  account, grant it the spaces and projects to share, and create its token; add the issues
  permission to each existing GitHub App and approve it per installation.

## Milestones

Build order. Each gets its own plan, written when the previous one is close to done.

| #   | Milestone           | Contents                                                                                                                                                                                                                                                                                | Rough size |
| --- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| K0  | Foundations         | Spikes: embedding on Vertex through the AI SDK; secretlint used as a library. Migrations, `knowledge` package, sink with redaction, SDK contract and harness, `KnowledgeSyncScheduler`, worker with chunk and embed, feature gating, compose and CI on a pgvector image, infra brief 2. | 2 weeks    |
| K1  | GitHub text         | Pull requests, issues, docs. Permission spike and banner. Alias dictionary and deterministic linking, references, entity Knowledge tab, the connector role gate.                                                                                                                        | 2 weeks    |
| K2  | Retrieval and tools | Hybrid search, the five tools, gateway ceiling 5, assistant grant, citations in Ask, keyword search route, the evaluation set.                                                                                                                                                          | 2 weeks    |
| K3  | Jira and Confluence | Atlassian spike (scopes, body format, restriction inheritance). Shared client and ADF walker, both connectors, wizard and container picker with acknowledgement, pruning, principals and identity matching, token expiry prompt.                                                        | 3 weeks    |
| K4  | Slack               | Manifest and wizard, threads and day buckets, poll and both reconcile passes, principals.                                                                                                                                                                                               | 2 weeks    |
| K5  | Suggestions         | The three generators, inbox UI spec and build, accept and reject paths, opt-in relation extraction.                                                                                                                                                                                     | 2–3 weeks  |
| K6  | Release hardening   | Purge and disconnect paths end to end, security review, success-criteria walkthrough on portal-demo, docs (`docs/knowledge.md`, `docs/connectors.md`, README).                                                                                                                          | 1 week     |

Total is roughly 14 to 15 weeks for one developer working with coding agents. These are
estimates, not a broken-down plan.

**Dependency on the agents work.** K0 needs the Postgres foundation from the agents
spec's Milestone 1: `db/migrations/`, the `pnpm db:migrate` runner in `packages/agents`,
Postgres in compose and CI. That plan
(`docs/superpowers/plans/2026-10-01-agents-foundation.md`) was executed on the branch on
2026-10-03, so K0 builds on real code. K2 needs the tool gateway and the runner from the same milestone. Success criterion 10
needs a write tool, which arrives with the agents spec's Milestone 3; until then ceiling 5
is covered by the runner's unit tests. Connector fetchers,
chunkers and the linker need neither and can be built against fixtures first. If the
agents foundation is late, the Postgres slice of it can be built first by either
workstream; it is small and self-contained.

Everything merges to `main` behind `knowledge.enabled: false` in the committed config
until K6.

## Deferred work

Recorded so that it is not lost. Each item names what would trigger it.

| #   | Item                                                                                                                                                                                                | Trigger                                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 1   | **Permission mirroring.** A permission-sync job per source, a real `visibilityPredicate`, per-user context for agents, then private Slack channels and restricted spaces.                           | A customer needs content that is not open to everyone. The `acl` columns are the seam. |
| 2   | **Legal read on Slack commercial distribution** and on Atlassian Developer Terms §6(f).                                                                                                             | Before any paid or hosted tier ships these connectors.                                 |
| 3   | **Slack live-search backend** (Real-time Search API, per-user OAuth) behind `KnowledgeSearchBackend`.                                                                                               | The legal read says a paid tier cannot index; or Slack changes its terms again.        |
| 4   | **Event-driven freshness.** Slack Events API or Socket Mode; the GitHub receiver for `pull_request`, `issues`, `issue_comment`; Jira admin webhooks. Confluence has none without Forge.             | A user needs answers about the last few minutes.                                       |
| 5   | **Semantic search in the web UI.** Grant api-server's service account the Vertex role, or route the query embedding through the worker.                                                             | Users want semantic search outside Ask. The cost is model-spend reach on a public pod. |
| 6   | **Knowledge tools on the external MCP server.** mcp-server needs Postgres and a query embedder.                                                                                                     | External agents need the knowledge layer.                                              |
| 7   | **Reranking** (Vertex ranking API, a Discovery Engine endpoint the AI SDK does not cover) and **model-generated chunk context**.                                                                    | The evaluation set shows a recall gap that hybrid search does not close.               |
| 8   | **True BM25** through `pg_textsearch`.                                                                                                                                                              | Keyword-leg quality limits results. Needs Postgres 17 and `shared_preload_libraries`.  |
| 9   | **Vertex batch mode** for backfill embedding.                                                                                                                                                       | A backfill is too slow or too costly at online rates.                                  |
| 10  | **Embedding model migration tooling** (a second embedding column, dual read, swap).                                                                                                                 | A better embedding model, or a dimension change.                                       |
| 11  | **Files and attachments.** Slack files, canvases and lists; Confluence attachments; PDFs and images.                                                                                                | Answers are missing because they live in attachments.                                  |
| 12  | **More sources.** GitHub Discussions (needs `discussions: read`, another re-approval), Google Drive, Notion, Linear, PagerDuty incidents, Jira changelog (status history), Jira Service Management. | Owner priority.                                                                        |
| 13  | **Slack breadth.** Slack Connect channels, Enterprise Grid org-wide install, fully automated app creation with `apps.manifest.create`.                                                              | A customer on Grid, or setup friction.                                                 |
| 14  | **Atlassian breadth.** OAuth client credentials for service accounts, a Forge app for a hosted tier, a Data Center variant (end of life 2029-03-28), an email source for identity matching.         | A hosted tier; a Data Center customer; poor identity match rates.                      |
| 15  | **Graph enrichment from sources.** `Person` property claims (Slack handle, email), property suggestions (a description drawn from a README), an expertise relationship type from person to service. | Owner wants the graph itself to carry these, not only the knowledge layer.             |
| 16  | **Auto-applying high-confidence suggestions**, and a `knowledge.propose_*` write tool so agents can create suggestions.                                                                             | The inbox proves accurate enough that review is a formality.                           |
| 17  | **Knowledge events as agent triggers** ("when a postmortem is indexed, run this agent").                                                                                                            | After the agents spec's event triggers ship.                                           |
| 18  | **Moving connector fetch out of api-server**, and a Postgres-backed connector registry.                                                                                                             | The scheduler is extracted so api-server can run more than one replica.                |
| 19  | **Personal-data handling** beyond secrets (classification, redaction), and an ingest-time injection flag as defence in depth.                                                                       | A customer or a review requires it.                                                    |
| 20  | **Deletion reaching agent transcripts** sooner than the transcript retention.                                                                                                                       | A compliance requirement.                                                              |
| 21  | **Retrieval analytics** (zero-result queries, most-cited sources) feeding the Adaptive Ontology idea in `ClaudePlans/07`.                                                                           | After release, to steer what to index next.                                            |
| 22  | **Multi-language full-text configuration.**                                                                                                                                                         | A non-English corpus.                                                                  |
| 23  | **Graph-expanded retrieval** beyond one hop, and a re-look at Neo4j 2026.x filtered vector search.                                                                                                  | The graph moves off Neo4j 5.                                                           |

## To confirm in review

Choices made in this document that the owner has not explicitly seen, or saw only in
summary:

1. **pgvector becomes a baseline requirement of the Postgres instance** (decision 10), and
   **Postgres 17 the floor**. This amends the Postgres brief, which belongs to the agents
   workstream and is already in the infra repo's inbox. Nobody has started that work, so
   the addendum can still travel with it.
2. **Restricted or unknown-visibility containers are selectable with an acknowledgement**
   (private GitHub repositories, restricted Confluence spaces, every Jira project). Only
   private Slack channels, direct messages and Slack Connect channels are excluded
   outright. The summary you approved said restricted pages and issues are never indexed,
   which holds; it did not spell out the container rule.
3. **A role gate on all connector mutations**, closing a gap that exists today for GitHub
   and Kubernetes connectors too.
4. **Un-threaded Slack messages are grouped into one document per channel per day.**
5. **Bot messages in Slack are indexed by default.**
6. **Accepted relation suggestions are written as the accepting person's manual edge**, so
   they rank as manual edits do.
7. **Slack history defaults to 365 days; GitHub to 365 days; Jira and Confluence to
   everything.**
8. **Ingestion does not depend on the agents feature being enabled.** Content can be
   indexed and browsed on entity pages with agents off.
9. **The knowledge worker is a separate Deployment**, one more pod on the demo cluster.

## Related

- `docs/agent/decisions/knowledge-layer-v1-foundations.md` — the owner's decisions.
- `docs/agent/plans/knowledge-connectors.md` — status and the deferred-work list.
- `docs/agent/briefs/infra-pgvector-for-knowledge.md` — the infra addendum.
- `docs/superpowers/specs/2026-10-01-ai-agents-and-workflows-design.md` — the tool gateway
  and Postgres foundation this builds on.
- `docs/adrs/ADR-005-defer-vector-db.md` — the deferral this ends. It recommended
  Weaviate; Postgres now exists, so pgvector replaces that recommendation.
- `docs/agent/decisions/kubernetes-connector-v1-design.md` — the connector-type factory
  and the poll-first precedent.
- `docs/agent/decisions/no-tenant-read-isolation-authenticated-sees-all.md` — the access
  model the curated visibility follows.
- `docs/agent/decisions/connector-apps-gsm-blob-durability.md` — where the new credentials
  are stored.
- `docs/adrs/ADR-017-secret-scanning-with-secretlint.md` — the redaction rule set.
