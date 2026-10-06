# ADR-035: Knowledge Layer v1 — An Indexed Store Beside the Graph, Curated Visibility, Reviewed Suggestions

## Status

Accepted (supersedes ADR-005's plan for a separate vector database)

## Date

2026-10-02

## Context

Some sources (pull requests, issues, documentation, Jira, Confluence, Slack) should not add resources to the graph. They should feed a searchable layer that agents and the platform chat can query, and influence how the graph connects. The owner answered the open choices on 2026-10-01 and 2026-10-02; the design is `docs/superpowers/specs/2026-10-02-knowledge-connectors-design.md`.

## Decision

1. **An indexed store in Postgres beside the graph:** documents, chunks and embeddings (pgvector `halfvec(768)` plus full-text search, fused by rank), linked to graph entities by canonical id. Content never becomes graph nodes, and knowledge connectors never publish to the event bus.
2. **Curated visibility:** an admin selects containers; everything indexed is visible to every signed-in user. Source permissions are recorded, unused, so per-user filtering can come later without re-ingesting.
3. **Deterministic links plus reviewed suggestions:** nothing inferred changes the graph until a person accepts it.
4. **Sources:** GitHub text first (pull requests, issues, docs; shipped as K1a), then Jira, Confluence and Slack through a customer-created app.
5. **Processes:** fetching runs in the api-server on the connector-type factory; a `knowledge-worker` process chunks, embeds (Vertex AI) and links. The feature is off unless `knowledge.enabled` is set and a database URL is configured.

## Consequences

### Positive

- One Postgres instance serves agents and knowledge; no new database engine.
- The graph stays curated: a wrong edge from a chat message is worse than a missing one.

### Negative

- pgvector is not a trusted extension: the instance needs a superuser bootstrap (`pnpm db:bootstrap` locally) and a pgvector image.
- Indexing GitHub issues needs an App permission every installation must re-approve.
- Slack and Atlassian terms need a legal read before any paid tier indexes them.

### Neutral

- Live-search backends can replace the index behind the retrieval interface later.

## Alternatives Considered

### Content as hidden nodes in Neo4j

- **Cons:** No filtered vector search on the deployed version; bloats the graph; contradicts "no new resources in the graph".

### Live search only

- **Cons:** Nothing processed offline, so no links or suggestions; results may not be stored.

### A separate vector database (ADR-005's Weaviate)

- **Cons:** Superseded once Postgres existed.

## References

- `docs/agent/decisions/knowledge-layer-v1-foundations.md`, `docs/agent/plans/knowledge-connectors.md`
- `db/migrations/0002_knowledge.sql`, `packages/knowledge/`, `packages/knowledge-worker/`
