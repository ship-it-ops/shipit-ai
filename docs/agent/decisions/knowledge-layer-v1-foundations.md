---
type: decision
status: active
created: 2026-10-02
updated: 2026-10-02
author: claude-session-2026-10-01-knowledge-connectors
tags: [knowledge, connectors, slack, jira, confluence, pgvector, retrieval, visibility]
importance: core
---

# Knowledge layer v1 foundations: indexed Postgres store, curated visibility, reviewed suggestions, four sources

## Context

The owner asked for connectors (Slack, Confluence, Jira, more later) that do not add
resources to the graph. They ingest content to influence how the graph connects and to
feed an indexed data layer that agents and the platform chat can query. A deep dive with
three research passes ran on 2026-10-01; the owner answered the open choices on 2026-10-01
and 2026-10-02. Full design:
`docs/superpowers/specs/2026-10-02-knowledge-connectors-design.md`.

## Decision

1. **Approach: an indexed store in Postgres beside the graph.** Documents, chunks and
   embeddings in Postgres (pgvector `halfvec(768)` plus built-in full text, fused by
   rank), linked to graph entities by canonical id. Content never becomes graph nodes and
   knowledge connectors never publish to the event bus.
2. **Visibility: curated now, mirroring later.** An admin selects containers; everything
   indexed is visible to every logged-in user. Source permissions are recorded on
   containers and documents, unused, so per-user filtering can be added without
   re-ingesting.
3. **Graph effect: deterministic links plus reviewed suggestions.** Nothing inferred
   changes the graph until a person accepts it; acceptance writes through the existing
   relation-edit service.
4. **Sources in v1: GitHub text (pull requests, issues, docs), Jira, Confluence, Slack.**
   GitHub issues are in even though `issues: read` forces every installation to re-approve
   the App; the owner said re-asking is fine.
5. **Slack is indexed through a customer-created app**, with retrieval behind an interface
   so a live-search backend can replace the index later.
6. **Use cases that define done:** operational history, decisions and rationale, who knows
   what, work status.

## Alternatives Considered

- **Content inside Neo4j as hidden nodes**: rejected — Neo4j 5 has no filtered vector
  search (it arrived in 2026.01), it bloats the graph store, and it contradicts "no new
  resources in the graph".
- **Live search only** (Slack Real-time Search, Atlassian Rovo MCP): rejected as the
  primary design — nothing is processed offline, so it cannot produce links or
  suggestions; results may not be stored; it needs per-user OAuth for every source.
- **Mirroring source permissions in v1**: rejected for now — permission-sync jobs and
  identity mapping are substantially more work.
- **Auto-applying inferred relations as low-confidence claims**: rejected — the graph is
  curated; a wrong edge from a chat message is worse than a missing one.
- **Weaviate** (ADR-005's earlier recommendation): superseded — Postgres now exists.
- **AGPL BM25 extensions** (ParadeDB `pg_search`, VectorChord-bm25): rejected on licence
  and Cloud SQL availability. `pg_textsearch` (PostgreSQL licence, Postgres 17+) stays an
  option, which is why Postgres 17 is the floor.

## Consequences

- **pgvector is not a trusted extension.** Only a superuser can `CREATE EXTENSION vector`,
  so `shipit_migrator` cannot. The Postgres instance needs a one-off bootstrap step and a
  pgvector image; see `docs/agent/briefs/infra-pgvector-for-knowledge.md`. This amends the
  agents workstream's Postgres brief, which was in the infra repo's inbox with no work
  started on 2026-10-02.
- **A new `knowledge-worker` process** does chunking, embedding and linking. Fetching runs
  in api-server on the connector-type factory.
- **A run that has read knowledge content needs human approval for writes** — one new
  ceiling in the agents tool gateway.
- **A role gate lands on connector mutations**, closing a gap that exists today.
- The work depends on the agents spec's Postgres foundation (its Milestone 1) and its tool
  gateway.

## Research findings worth keeping (read 2026-10-01; re-verify before relying on them)

**Slack**

- API terms effective 2025-10-10 restrict bulk export and LLM training for providers of
  apps "offered for use outside your organization"; Slack states internal custom apps are
  not covered. https://slack.com/terms-of-service/api,
  https://docs.slack.dev/changelog/2025/10/13/api-terms-update
- Commercial distribution includes providing "a custom Application or Application
  template" connected to a paid product, and requires the Marketplace; Marketplace apps may
  not copy messages. **This needs a legal read before any paid tier ships Slack indexing.**
- New unlisted commercially distributed apps get 1 request per minute and 15 messages per
  request on `conversations.history` and `conversations.replies`; internal apps keep Tier 3.
  https://docs.slack.dev/changelog/2025/05/29/rate-limit-changes-for-non-marketplace-apps
- Real-time Search API and the Slack MCP server (public 2026-02-17) act as the user and
  forbid storing results. https://docs.slack.dev/apis/web-api/real-time-search-api
- Unverified: whether retention-policy purges emit delete events; whether canvas bodies
  and huddle transcripts are readable.

**Atlassian**

- Default auth for self-hosted: a service account with a scoped API token against
  `api.atlassian.com/ex/{jira|confluence}/{cloudId}`. Token traffic is exempt from the
  points-based quotas enforced since 2026-03-02. Tokens expire within 365 days.
  https://developer.atlassian.com/cloud/jira/platform/rate-limiting/
- Jira `/rest/api/3/search` is removed; use `/search/jql` with token pagination plus
  `/issue/bulkfetch`. No supported API reads linked pull requests.
- Confluence REST v2 has no modified-since filter; use CQL `lastmodified` on the v1 search
  endpoint. Confluence webhooks exist only for Forge and Connect apps. Connect reaches end
  of support in Q4 2026.
- Emails are hidden by default, so matching Atlassian users to `Person` is weak.
- Developer Terms (effective 2025-12-01) §6(f) forbid apps that "substantially replicate"
  Atlassian features; a hosted search product deserves a legal read.
- Not re-verified from a primary page: exact scope names, comment and changelog endpoint
  details, restriction inheritance. The K3 spike settles them.

**Retrieval**

- pgvector 0.8.7; `halfvec` indexes up to 4,000 dimensions; iterative scans since 0.8.0
  keep filtered searches from starving. Cloud SQL ships 0.8.5.
- `gemini-embedding-2` (GA 2026-04-22): up to 3,072 dimensions with truncation to 768,
  8,192 input tokens. The AI SDK Vertex provider sends it one value per call. Task type
  defaults to `RETRIEVAL_QUERY` when left blank, so documents must set
  `RETRIEVAL_DOCUMENT`.
- Vertex reranking lives on Discovery Engine, not `aiplatform`, and the AI SDK's `rerank`
  does not cover it.
- Embedding 10 million chunks costs roughly $600 to $800 one-off (derived, not quoted).

## Revisit Triggers

- A customer needs content that is not open to everyone → build permission mirroring.
- Any paid or hosted tier → the Slack and Atlassian legal reads, and possibly the Slack
  live-search backend.
- Users need answers about the last few minutes → event-driven freshness.
- The retrieval evaluation set shows a recall gap → reranking or model-generated context.
- The scheduler is extracted from api-server → connector fetch moves with it.

## Related

- [knowledge-connectors](../plans/knowledge-connectors.md) — status and the deferred-work list
- [agent-platform-v1-foundations](agent-platform-v1-foundations.md) — the Postgres and Vertex foundation this builds on
- [no-tenant-read-isolation-authenticated-sees-all](no-tenant-read-isolation-authenticated-sees-all.md) — the access model the curated visibility follows
- [kubernetes-connector-v1-design](kubernetes-connector-v1-design.md) — connector-type factory and poll-first precedent
- [connector-apps-gsm-blob-durability](connector-apps-gsm-blob-durability.md) — where the new credentials are stored
