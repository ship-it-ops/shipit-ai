# ADR-005: Defer Vector Database and Semantic Search to Phase 2

## Status

Accepted

## Date

2026-02-28

## Context

The v0.2 design document included a vector database (Weaviate or Qdrant), an Embedding Generator service, and a `semantic_search` MCP tool as Phase 1 deliverables. These components would enable AI agents to search for entities by natural language description rather than exact identifiers (e.g., "find services related to payments" rather than `canonical_id = payment-service`).

### Why vector search is premature in Phase 1

1. **Sparse embeddable content.** In Phase 1, the only connectors are GitHub and Kubernetes. The embeddable text available from these sources is limited to:
   - GitHub repository README files (often boilerplate or absent).
   - GitHub repository descriptions (typically 1-2 sentences).
   - Kubernetes resource annotations and labels (short key-value pairs, not natural language).
   - CODEOWNERS file entries (structured, not semantic).

   This is insufficient corpus density to produce meaningful embeddings. A vector search over sparse, low-quality text will return noisy results that erode trust in the tool.

2. **Infrastructure cost.** Weaviate requires 1-2 GB of RAM as a minimum deployment. Adding it to the Docker Compose stack pushes the total memory footprint from ~2 GB (Neo4j + Redis + App) to ~4 GB. This conflicts with the Phase 1a goal of a lightweight getting-started experience (see ADR-003).

3. **Embedding pipeline complexity.** Generating embeddings requires either a local model (e.g., `all-MiniLM-L6-v2` via ONNX or sentence-transformers) or an external API (OpenAI, Cohere). Both add operational complexity:
   - Local model: requires a Python microservice (see ADR-001), GPU/CPU resources, and model management.
   - External API: requires API keys, rate limiting, cost management, and network dependency.

4. **Phase 1 search is adequate with structural queries.** The primary Phase 1 use cases -- blast radius, dependency chains, entity lookup -- are structural graph queries. Users can find entities by canonical ID, name, type, or linking key. The `list_entities` MCP tool (Phase 1b) provides filtered search by type, name substring, and tags. This covers the Phase 1 use cases without semantic search.

### When vector search becomes valuable

Vector search becomes genuinely useful when:

- **Backstage connector** (Phase 2) brings in catalog descriptions, API specs, and documentation links -- rich, natural-language text per entity.
- **Datadog connector** (Phase 2) brings in service descriptions, dashboard names, and monitor descriptions.
- **PagerDuty connector** (Phase 2) brings in service descriptions and escalation policy names.
- **Entity count exceeds ~500**, making browsing impractical and search essential.

At that point, the embedding corpus is dense enough to produce meaningful semantic similarity results.

## Decision

We will defer the following components to Phase 2:

1. **Vector database (Weaviate)** -- not included in Phase 1 Docker Compose or infrastructure.
2. **Embedding Generator service** -- no embedding pipeline in Phase 1.
3. **`semantic_search` MCP tool** -- not implemented in Phase 1.

Phase 1 search capabilities are limited to **structural queries only**:

- Lookup by `canonical_id` (exact match).
- Lookup by `linking_key` (exact match).
- Lookup by `name` (substring or exact match).
- Filtered listing by entity type and tags via `list_entities`.

When Weaviate ships in Phase 2, it will be integrated as follows:

- Weaviate runs as an additional Docker Compose service.
- The Embedding Generator is a worker process that subscribes to entity events and generates embeddings on entity create/update.
- Embeddings are stored in Weaviate with a reference to the Neo4j canonical ID.
- The `semantic_search` MCP tool queries Weaviate, retrieves matching canonical IDs, and then fetches full entity data from Neo4j.

## Consequences

### Positive

- **Lighter Phase 1 footprint.** Docker Compose stays under 2 GB RAM without a vector database. Faster startup, simpler debugging, lower barrier to entry.
- **No premature optimization.** Avoids investing in embedding infrastructure before there is sufficient embeddable content to make it useful.
- **Focused Phase 1 scope.** One fewer component to build, test, and debug. Engineering effort stays on the walking skeleton (see ADR-003).
- **No external API dependency.** Phase 1 does not require OpenAI or Cohere API keys for embedding generation, simplifying onboarding for air-gapped or cost-sensitive environments.

### Negative

- **No natural language search in Phase 1.** Users cannot ask "find services related to payments" -- they must know the entity name or ID. This is a limitation for discovery use cases. **Mitigation:** The `blast_radius` tool provides relationship-based discovery. The `list_entities` tool provides filtered browsing. These cover the primary Phase 1 use cases.
- **Phase 2 integration effort.** Adding Weaviate, the Embedding Generator, and `semantic_search` in Phase 2 is a non-trivial integration effort that must be planned. **Mitigation:** The MCP response envelope (ADR-008) and the event bus interface (ADR-004) are designed to accommodate new tools and consumers. The `semantic_search` tool is a new MCP tool, not a modification to existing ones.
- **Delayed feature parity with competitors.** Some service catalog tools offer search out of the box. Phase 1 users comparing ShipIt-AI to alternatives may perceive the lack of search as a gap. **Mitigation:** ShipIt-AI's differentiator is AI-agent-native graph queries, not keyword search. The walking skeleton demonstrates this differentiator.

### Neutral

- The decision to use Weaviate specifically (vs. Qdrant, Pinecone, pgvector) is deferred to Phase 2 planning. The current recommendation is Weaviate based on its open-source availability, REST/GraphQL API, and multi-tenancy support, but this will be revisited when Phase 2 scoping begins.

## Alternatives Considered

### Alternative 1: Include Weaviate in Phase 1 with Minimal Embeddings

- **Pros:** Feature is available from day one. Early adopters can experiment with semantic search. Infrastructure is in place for Phase 2 connectors.
- **Cons:** 1-2 GB additional RAM. Embeddings over sparse GitHub data produce noisy results. Embedding pipeline adds complexity (Python microservice or external API). Diverts engineering effort from the walking skeleton.
- **Why rejected:** The cost (RAM, complexity, engineering time) is not justified by the value (poor-quality search over sparse data). Better to ship it when the data is rich enough to make it useful.

### Alternative 2: Use Neo4j Full-Text Search Instead of Vector Search

- **Pros:** No additional infrastructure. Neo4j 5 supports full-text indexes via Apache Lucene. Keyword search is better than nothing.
- **Cons:** Full-text search is keyword-based, not semantic. It cannot handle conceptual queries like "find services related to payments" if the word "payments" does not appear in the entity's properties. It is a partial solution that may set incorrect expectations.
- **Why rejected:** Full-text search is a viable Phase 1 enhancement but does not replace the need for vector search in Phase 2. If needed, it can be added as a lightweight improvement without this ADR's scope. The `list_entities` tool with substring matching provides equivalent functionality for Phase 1.

### Alternative 3: Use pgvector in PostgreSQL

- **Pros:** Avoids adding a separate vector database. PostgreSQL is a common dependency. pgvector supports approximate nearest neighbor search.
- **Cons:** Adds PostgreSQL as a Phase 1 dependency (currently deferred to Enterprise audit use cases per ADR-002). pgvector's performance at scale is weaker than purpose-built vector databases. Still requires an embedding pipeline.
- **Why rejected:** Introduces PostgreSQL dependency in Phase 1, conflicting with the minimal infrastructure goal. Deferred to Phase 2 evaluation alongside Weaviate and Qdrant.
