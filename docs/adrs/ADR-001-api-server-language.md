# ADR-001: Commit to TypeScript for API Server

## Status

Accepted

## Date

2026-02-28

## Context

ShipIt-AI requires an API server to power its knowledge graph platform, serving as the backbone for the MCP Server, Core Writer, and Connector SDK. The choice of primary server-side language is one of the most consequential early decisions because it affects hiring, developer velocity, code sharing, tooling, and long-term maintenance burden.

The following forces informed this decision:

1. **Frontend alignment.** The ShipIt-AI frontend is built with Next.js, which is TypeScript-native. A TypeScript backend enables full-stack type sharing (e.g., shared interfaces for API request/response schemas, entity types, and graph query results) without code generation or translation layers.

2. **Connector SDK interface.** The Connector SDK -- the interface that third-party and internal developers use to write connectors (GitHub, K8s, Backstage, Datadog, etc.) -- is already defined in TypeScript. Keeping the server in the same language means connector authors do not need to bridge between type systems.

3. **Team context switching.** A single-language stack means every engineer can move between frontend, API server, MCP server, Core Writer, and connector development without switching paradigms. This is especially important for a small team where individuals must wear multiple hats.

4. **Ecosystem maturity.** The Node.js/TypeScript ecosystem has mature libraries for the core ShipIt-AI requirements: Neo4j driver (`neo4j-driver`), Redis/BullMQ, Kafka (`kafkajs`), YAML parsing, JSON Schema validation, GraphQL, and REST frameworks (Express, Fastify, or tRPC).

5. **AI agent implementation.** Development will be heavily assisted by AI coding agents. TypeScript has strong AI tooling support (Copilot, Claude, etc.) and the single-language consistency makes agent-generated code more reliable across the stack.

6. **ML considerations.** Some future features (embedding generation, fuzzy matching scoring, ML-based entity resolution) may benefit from Python's ML ecosystem (sentence-transformers, scikit-learn, spaCy). However, these are Phase 2+ concerns and can be isolated into a dedicated Python microservice if needed, rather than dictating the primary stack choice.

## Decision

**TypeScript (Node.js) is the primary language for all server-side components of ShipIt-AI**, including:

- **API Server** (REST/tRPC endpoints for the frontend and external consumers)
- **MCP Server** (Model Context Protocol server exposing `blast_radius`, `entity_detail`, `schema_info`, and future tools to AI agents)
- **Core Writer** (the ingestion engine that receives events from connectors, resolves entities, and writes to Neo4j)
- **Connector SDK** (the TypeScript SDK that connector authors use to emit standardized entity events)
- **Event Bus Interface** (the abstraction layer over BullMQ/Kafka)
- **Schema Validation CLI** (command-line tool for validating YAML/JSON schema files)

A separate Python microservice is permitted **only** if a future feature (specifically: embedding generation, ML-based entity resolution, or fuzzy matching scoring) requires Python-only libraries with no viable TypeScript equivalent. This microservice would be a narrowly scoped worker process, not a second API server.

The runtime target is **Node.js 20 LTS** (or later LTS releases). The TypeScript configuration will use strict mode with the following key settings:

- `strict: true`
- `noUncheckedIndexedAccess: true`
- `exactOptionalPropertyTypes: true`

Package management will use **pnpm** with a monorepo workspace structure to share types and utilities across packages.

## Consequences

### Positive

- **Full-stack type safety.** Shared TypeScript interfaces between frontend, API server, MCP server, and Connector SDK eliminate an entire class of serialization/deserialization bugs. Changes to entity types propagate as compile-time errors across the entire stack.
- **Reduced hiring complexity.** One language requirement instead of two. Every backend engineer can also contribute to frontend work and vice versa.
- **Monorepo efficiency.** A pnpm workspace monorepo with shared packages (`@shipit/types`, `@shipit/graph-client`, `@shipit/event-schemas`) enables code reuse without publishing to a registry during development.
- **Faster development velocity.** No context switching cost between languages. AI coding agents produce more consistent output when the entire codebase is in one language.
- **Strong async I/O model.** Node.js's event loop is well-suited for ShipIt-AI's workload profile: high-concurrency I/O (Neo4j queries, API calls to GitHub/K8s, Redis pub/sub) with minimal CPU-bound computation.
- **Mature ecosystem.** Production-grade libraries exist for every core dependency: `neo4j-driver`, `kafkajs`, `bullmq`, `zod` (schema validation), `@modelcontextprotocol/sdk` (MCP), `js-yaml`, and `ajv`.

### Negative

- **ML escape hatch adds complexity.** If a Python microservice is needed for ML tasks, the team must maintain cross-language deployment, inter-service communication (likely gRPC or HTTP), and two CI/CD pipelines for that component.
- **CPU-bound limitations.** If entity resolution or graph traversal logic becomes CPU-intensive, Node.js's single-threaded model may require worker threads or offloading to a separate process. This is mitigable with `worker_threads` or by decomposing into async steps.
- **TypeScript compilation overhead.** Large TypeScript monorepos can have slow compilation times. This is mitigable with project references, incremental builds, and tools like `tsx` or `esbuild` for development.

### Neutral

- The Neo4j JavaScript driver is functionally equivalent to the Python driver. Neither has a significant advantage for ShipIt-AI's query patterns.
- TypeScript's type system is structural (not nominal), which is a different design philosophy than Python's type hints but neither is objectively better for this use case.

## Alternatives Considered

### Alternative 1: Python with FastAPI

- **Description.** Use Python 3.12+ with FastAPI for the API server, Pydantic for data validation, and the Neo4j Python driver. Python has a superior ML ecosystem (sentence-transformers, scikit-learn, numpy, pandas) and FastAPI provides automatic OpenAPI documentation.
- **Why rejected.** Splits the stack between TypeScript (frontend, Connector SDK) and Python (backend). This requires maintaining two type systems, increases context switching for developers, and means connector SDK types must be duplicated or generated via code generation. The ML advantages are not needed until Phase 2+ and can be addressed with a narrowly scoped Python microservice at that time. FastAPI's async model is strong but Python's overall async ecosystem is less mature than Node.js's.

### Alternative 2: Go

- **Description.** Use Go for the API server. Go offers excellent performance, built-in concurrency primitives (goroutines), fast compilation, and produces small static binaries ideal for container deployments.
- **Why rejected.** Go's type system is significantly different from TypeScript's (no generics until recently, no union types, no pattern matching). This means no type sharing with the frontend or Connector SDK. Go's ecosystem for graph databases and MCP is less mature. The development velocity advantage of TypeScript's type inference and higher-level abstractions outweighs Go's runtime performance benefits for ShipIt-AI's I/O-bound workload.

### Alternative 3: Rust

- **Description.** Use Rust for the API server. Rust provides memory safety without garbage collection, exceptional performance, and strong type guarantees.
- **Why rejected.** Overkill for ShipIt-AI's use case. The API server is I/O-bound (querying Neo4j, calling external APIs, serving JSON), not compute-bound. Rust's compile times and learning curve would significantly slow development velocity. The hiring pool for Rust developers is much smaller. There is no meaningful benefit from Rust's memory safety guarantees for a knowledge graph API server.

## References

- ShipIt-AI Design Document v0.2
- [Node.js 20 LTS Release](https://nodejs.org/en/blog/release/v20.9.0)
- [Neo4j JavaScript Driver](https://neo4j.com/docs/javascript-manual/current/)
- [Model Context Protocol TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)
