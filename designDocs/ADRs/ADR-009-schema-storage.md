# ADR-009: Store Schema in Neo4j as Meta-Nodes

## Status

Accepted

## Date

2026-02-28

## Context

ShipIt-AI's knowledge graph is governed by an ontology schema that defines:

- **Node types** (e.g., `LogicalService`, `Repository`, `Deployment`, `RuntimeService`, `Team`, `Person`).
- **Property keys** for each node type, including data types, required vs. optional, and default values.
- **Resolution strategies** for each property (e.g., `latest_write_wins`, `highest_tier_wins`, `manual_override`).
- **Cardinality constraints** on relationships (e.g., a `Deployment` must have exactly one `DEPLOYED_IN` edge to an `Environment`).
- **Relationship types** with their valid source and target node labels.
- **Versioning information** to track schema evolution over time.

This schema is referenced by multiple system components:

- **Core Writer** uses it to validate incoming data and apply resolution strategies during reconciliation.
- **MCP server** uses it via the `schema_info` tool to expose the ontology to AI agents, enabling them to formulate valid queries.
- **Connectors** use it to understand which properties they should populate and what node types they produce.
- **UI (Schema Explorer)** uses it to render the ontology for human operators.

The open question is where this schema should live. The options range from storing it in Neo4j itself (as meta-nodes) to maintaining it in an external store (JSON file, PostgreSQL, Git-backed YAML). The choice affects queryability, versioning, operational simplicity, and consistency guarantees.

## Decision

We will store the ontology schema in Neo4j as meta-nodes and meta-relationships, using dedicated labels prefixed with `Schema` to distinguish them from domain data.

### Schema Meta-Node Structure

**`:SchemaNodeType`** -- One node per domain node label:

```
(:SchemaNodeType {
  name: "LogicalService",
  description: "A logical service representing a business capability",
  version: 3,
  created_at: datetime(),
  updated_at: datetime(),
  is_active: true
})
```

**`:SchemaProperty`** -- One node per property definition:

```
(:SchemaProperty {
  name: "tier_effective",
  data_type: "string",
  required: true,
  default_value: "tier-3",
  resolution_strategy: "highest_tier_wins",
  description: "Effective service tier after resolution",
  valid_values: ["tier-1", "tier-2", "tier-3"]
})
```

**`:SchemaRelationship`** -- One node per relationship type:

```
(:SchemaRelationship {
  type: "IMPLEMENTED_BY",
  description: "Links a LogicalService to its source code Repository",
  cardinality: "one-to-many",
  required: true
})
```

### Schema Meta-Relationships

- `(:SchemaNodeType)-[:HAS_PROPERTY]->(:SchemaProperty)` -- Links node types to their properties.
- `(:SchemaRelationship)-[:FROM_TYPE]->(:SchemaNodeType)` -- Valid source label for a relationship.
- `(:SchemaRelationship)-[:TO_TYPE]->(:SchemaNodeType)` -- Valid target label for a relationship.
- `(:SchemaNodeType)-[:VERSION_OF]->(:SchemaNodeType)` -- Links a new version to its predecessor for rollback.

### Schema Versioning

When the schema is modified (e.g., adding a new property, changing a resolution strategy):

1. The existing `:SchemaNodeType` node is marked `is_active: false`.
2. A new `:SchemaNodeType` node is created with `version: N+1` and `is_active: true`.
3. A `[:VERSION_OF]` relationship links the new version to the previous version.
4. All associated `:SchemaProperty` and `:SchemaRelationship` nodes are duplicated for the new version (copy-on-write) so that the previous version remains intact.
5. The entire operation executes in a single Neo4j transaction to ensure atomicity.

This enables:

- **Rollback:** Reactivate the previous version and deactivate the current one.
- **Audit trail:** Full history of schema changes is preserved in the graph.
- **Concurrent reads:** The `schema_info` MCP tool always reads `is_active: true` nodes, so schema updates do not cause inconsistent reads.

### Querying the Schema

The `schema_info` MCP tool queries the schema directly:

```cypher
MATCH (nt:SchemaNodeType {is_active: true})
OPTIONAL MATCH (nt)-[:HAS_PROPERTY]->(p:SchemaProperty)
OPTIONAL MATCH (sr:SchemaRelationship)-[:FROM_TYPE]->(nt)
OPTIONAL MATCH (sr)-[:TO_TYPE]->(target:SchemaNodeType {is_active: true})
RETURN nt, collect(DISTINCT p) AS properties,
       collect(DISTINCT {rel: sr, target: target.name}) AS relationships
```

### Schema Initialization

On first deployment, the schema is seeded from a YAML file (`schema/ontology-v1.yaml`) that is part of the application codebase. The Core Writer reads this file on startup and creates the corresponding meta-nodes if they do not already exist. Subsequent schema changes are applied via schema migration scripts that modify the meta-nodes in-place.

### Namespace Isolation

All schema meta-nodes use the `Schema` label prefix. Cypher queries for domain data should never match schema nodes, and vice versa. The Core Writer enforces this by never applying domain operations to `Schema`-prefixed labels.

## Consequences

### Positive

- **Schema-as-graph is queryable via Cypher.** The `schema_info` MCP tool, the UI Schema Explorer, and ad-hoc debugging queries all use the same Cypher interface. No additional API or query language is needed.
- **Single source of truth.** Both the schema and the data it governs live in the same Neo4j instance. There is no sync problem between two stores, no cache invalidation, and no risk of schema drift.
- **Transactional consistency.** Schema changes and data changes use the same Neo4j transaction model. A schema migration can atomically update both the schema meta-nodes and any affected domain data in a single transaction.
- **Version history is a graph.** The `[:VERSION_OF]` chain provides a natural, queryable audit trail. Rollback is a graph operation, not a file restore.
- **AI agents can introspect the schema.** When an agent calls `schema_info`, it gets a live, authoritative view of the ontology, enabling it to construct valid queries and understand the data model dynamically.

### Negative

- **Schema and data share failure domain.** If Neo4j goes down, both the data and the schema are unavailable. Mitigated by ADR-007 (Neo4j HA strategy) and by the fact that an unavailable Neo4j makes the data useless anyway, so schema availability is moot.
- **Copy-on-write versioning increases storage.** Each schema version duplicates all property and relationship nodes. For a schema with ~20 node types and ~80 properties, each version adds ~100 nodes. At one schema change per week, this is ~5,200 nodes per year -- negligible relative to domain data volume.
- **Schema queries add load to Neo4j.** The `schema_info` tool queries meta-nodes on every call. Mitigated by the small size of the schema subgraph and by caching the schema response in the MCP server with a 5-minute TTL.
- **More complex than a static file.** A JSON or YAML file is simpler to understand and edit. The meta-node approach requires understanding the schema-as-graph model. Mitigated by providing the YAML seed file as the human-editable source and tooling to apply it to Neo4j.
- **Migration scripts must be idempotent.** Because schema changes are graph operations, migration scripts must handle partial failures and re-runs gracefully. Each migration script checks preconditions before applying changes.

## Alternatives Considered

### Alternative 1: External JSON File

- **Description:** Store the schema as a JSON file in the application repository (e.g., `schema/ontology.json`). Load it into memory at application startup. The `schema_info` MCP tool reads from this in-memory representation.
- **Rejected because:** No built-in versioning -- changes require Git commits and redeployment. No runtime queryability -- the schema cannot be explored via Cypher. Schema drift is possible if the file and the actual graph state diverge after manual Neo4j changes. No transactional consistency between schema and data changes.

### Alternative 2: PostgreSQL Schema Store

- **Description:** Store the schema in a PostgreSQL database with tables for node types, properties, relationships, and versions. The Core Writer and MCP server query PostgreSQL for schema information.
- **Rejected because:** Adds PostgreSQL as an additional infrastructure dependency. ShipIt-AI's data tier is intentionally Neo4j-centric. Introducing a relational database for schema storage creates an additional failure mode, a separate connection pool, and a synchronization problem between two databases. The benefit of relational schema storage does not justify the operational cost.

### Alternative 3: Git-Backed YAML with Runtime Sync

- **Description:** Store the schema as YAML files in a Git repository. A sync process watches the repository and applies changes to a runtime store (Redis or Neo4j) whenever the YAML files change.
- **Rejected because:** Excellent for version control and human editing, but poor for runtime queries. Introduces a sync process that can fail, creating schema drift. The two-step process (edit YAML, wait for sync) adds latency to schema changes. The Git history provides versioning, but it is not queryable from within the graph or by AI agents.

### Alternative 4: Schema as Neo4j Constraints and Indexes Only

- **Description:** Use Neo4j's built-in constraint and index system to define the schema (e.g., uniqueness constraints, existence constraints, property type constraints in Neo4j 5+).
- **Rejected because:** Neo4j's constraint system is limited to structural validation (uniqueness, existence, type). It cannot express ShipIt-AI-specific concepts like resolution strategies, cardinality semantics, service tier logic, or property descriptions. The meta-node approach supports arbitrary schema metadata that Neo4j constraints cannot represent. However, we will use Neo4j constraints in addition to meta-nodes for structural enforcement where applicable.
