---
type: plan
status: active
created: 2026-10-02
updated: 2026-10-02
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

The K0 foundation this plan needs is the agents workstream's plan
`docs/superpowers/plans/2026-10-01-agents-foundation.md` (written, not executed). Its
compose and CI Postgres image must become a pgvector image for the knowledge migrations.

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

Spec written 2026-10-02 and **approved by the owner on 2026-10-03** ("you are good"),
including the nine choices in its "To confirm in review" section, which were shown in
summary and not individually confirmed. Committed on branch `ai-agents-design` on
2026-10-03 (`git log --oneline -- docs/superpowers/specs/2026-10-02-knowledge-connectors-design.md`
gives the SHA). Nothing is implemented. Next: the implementation plan for K0 and K1.

## Related

- [knowledge-layer-v1-foundations](../decisions/knowledge-layer-v1-foundations.md) — owner decisions and research findings
- [ai-agents-and-workflows](ai-agents-and-workflows.md) — the sibling plan this depends on
- [agent-platform-v1-foundations](../decisions/agent-platform-v1-foundations.md) — Postgres and Vertex foundation
- [redis-memory-limit-below-dataset-oomkills](../scars/redis-memory-limit-below-dataset-oomkills.md) — why no content or id lists enter Redis
- [docker-builder-copies-fixed-package-set](../scars/docker-builder-copies-fixed-package-set.md) — applies to every new package here
