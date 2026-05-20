# ADR-002: Store PropertyClaims as JSON on Entity Nodes

## Status

Accepted

## Date

2026-02-28

## Context

ShipIt-AI's Core Writer ingests data from multiple connectors (GitHub, Kubernetes, Backstage, Datadog, PagerDuty, etc.) and must reconcile conflicting property values from different sources. The v0.2 design document introduced a **PropertyClaim** model where every property value assertion from every source is stored as a separate Neo4j node, linked to its parent entity via a `HAS_CLAIM` relationship.

### The scale problem

Consider a modest deployment with 5,000 entities (services, repositories, teams, APIs). Each entity has approximately 10 properties. Each property may have claims from 3 different sources (e.g., GitHub says the owner is "team-alpha", Backstage says "Team Alpha", PagerDuty says "team_alpha"). This produces:

- **5,000 entity nodes**
- **150,000 PropertyClaim nodes** (5,000 x 10 x 3)
- **150,000 HAS_CLAIM relationships**

The PropertyClaim nodes outnumber entity nodes 30:1. For a larger enterprise deployment (50,000 entities), this becomes 1.5 million PropertyClaim nodes — before considering historical claims or audit trails.

### The operational impact

1. **Write amplification.** Every connector sync that updates a single property on an entity requires creating/updating a PropertyClaim node AND updating the HAS_CLAIM relationship. A bulk sync of 1,000 entities touching 5 properties each generates 5,000 node writes + 5,000 relationship writes, on top of the 1,000 entity node updates.

2. **Query degradation.** Common queries like "get entity with all its resolved properties" require traversing HAS_CLAIM edges and aggregating claims. The `blast_radius` query — ShipIt-AI's flagship MCP tool — must traverse relationships between entities; adding a HAS_CLAIM fan-out at every node multiplies the traversal cost.

3. **Storage bloat.** Each Neo4j node carries overhead (node headers, property storage, relationship chain pointers). 150K nodes of small, repetitive data (source, timestamp, confidence, value) is an inefficient use of the graph storage engine.

4. **Complexity in the Core Writer.** The resolution logic must query all claims for a property, apply the resolution strategy (latest-wins, priority-source, manual-override), and update the entity's resolved value. With separate nodes, this is a multi-step Cypher query with aggregation.

### Neo4j 5 capabilities

Neo4j 5 supports rich property types including lists and maps. A JSON array stored as a string property (or a list-of-maps if using APOC) can hold claim data directly on the entity node. Neo4j's `apoc.convert.fromJsonList` and native map operations make this data accessible in Cypher when needed.

## Decision

We will store PropertyClaims as a **JSON array property** on entity nodes rather than as separate graph nodes.

### Storage format

Each entity node will have an optional `_claims` property containing a JSON string. The JSON structure is an object keyed by property name, where each key maps to an array of claim objects:

```json
{
  "owner": [
    {
      "source": "github",
      "connectorId": "github-acme-org",
      "value": "team-alpha",
      "timestamp": "2026-02-28T10:30:00Z",
      "confidence": 0.9,
      "evidence": "CODEOWNERS file"
    },
    {
      "source": "backstage",
      "connectorId": "backstage-prod",
      "value": "Team Alpha",
      "timestamp": "2026-02-27T14:00:00Z",
      "confidence": 0.95,
      "evidence": "catalog-info.yaml"
    }
  ],
  "language": [
    {
      "source": "github",
      "connectorId": "github-acme-org",
      "value": "TypeScript",
      "timestamp": "2026-02-28T10:30:00Z",
      "confidence": 1.0,
      "evidence": "GitHub linguist API"
    }
  ]
}
```

### Resolution behavior

The **resolved value** of each property is stored as a top-level property on the entity node (e.g., `owner: "team-alpha"`). The `_claims` property stores the provenance and competing values. The Core Writer's resolution strategy reads `_claims`, applies the configured strategy (latest-wins, priority-source, highest-confidence, manual-override), and sets the top-level property.

### Claim Explorer UI

The frontend Claim Explorer component reads the `_claims` JSON from the API response and renders it as a table showing source, value, timestamp, and confidence for each property. No additional graph queries are needed.

### Enterprise audit table (optional)

For Enterprise-tier deployments that need cross-entity claim queries (e.g., "show me all entities where Backstage and GitHub disagree on the owner"), the Core Writer can optionally materialize claims into a **PostgreSQL audit table** with the following schema:

```sql
CREATE TABLE property_claims (
    id UUID PRIMARY KEY,
    entity_canonical_id TEXT NOT NULL,
    property_name TEXT NOT NULL,
    source TEXT NOT NULL,
    connector_id TEXT NOT NULL,
    value JSONB NOT NULL,
    confidence FLOAT,
    timestamp TIMESTAMPTZ NOT NULL,
    evidence TEXT,
    INDEX idx_claims_source (source),
    INDEX idx_claims_property (property_name),
    INDEX idx_claims_entity (entity_canonical_id)
);
```

This is a write-behind pattern: the Core Writer writes claims to Neo4j (on the entity node) and asynchronously inserts into PostgreSQL for analytical queries. This is a Phase 2+ feature.

### Graph node expansion (audit view)

For compliance or deep provenance use cases, a future "audit view" can materialize `_claims` JSON back into separate graph nodes on demand. This is a read-time expansion, not a storage-time decision. The API would accept a `?expand=claims` parameter to return the expanded view.

## Consequences

### Positive

- **10-30x node count reduction.** A 5,000-entity deployment has ~5,000 nodes instead of ~155,000. This directly improves Neo4j memory usage, query planning, and backup/restore times.
- **Faster writes.** Updating claims is a single property update on an existing node (`SET n._claims = $claims`) rather than MERGE + CREATE for separate claim nodes and relationships.
- **Simpler Cypher queries.** The `blast_radius` query traverses entity-to-entity relationships without fan-out through claim nodes. Query plans are simpler and more predictable.
- **Atomic entity operations.** An entity and all its claims are a single node. Deleting an entity deletes its claims. No orphaned claim nodes.
- **Reduced relationship count.** Eliminating HAS_CLAIM relationships keeps the graph focused on meaningful domain relationships (OWNS, DEPLOYED_ON, DEPENDS_ON, CALLS).
- **API response simplicity.** A single node fetch returns the entity with all claims. No joins, no aggregation, no additional queries.

### Negative

- **No native Cypher claim queries.** You cannot write `MATCH (c:PropertyClaim {source: 'backstage'})` to find all Backstage claims. Querying claims across entities requires JSON parsing in Cypher (via `apoc.convert.fromJsonList`) or the PostgreSQL audit table. **Mitigation:** Cross-entity claim queries are an Enterprise/analytical use case addressed by the PostgreSQL audit table in Phase 2.
- **JSON property size limits.** A single entity with many properties and many sources could have a large `_claims` JSON string. For an entity with 20 properties x 5 sources x 200 bytes per claim = ~20KB per entity. This is well within Neo4j's property size limits but should be monitored. **Mitigation:** Set a maximum claim history depth (e.g., keep only the latest 5 claims per property per source). Older claims are archived to PostgreSQL.
- **Schema flexibility risk.** The `_claims` JSON structure is not enforced by Neo4j. A bug in the Core Writer could write malformed claims. **Mitigation:** Validate `_claims` JSON against a Zod schema in the Core Writer before writing. Add a schema validation check in the health/diagnostics endpoint.
- **Migration complexity.** If we later decide that separate claim nodes are necessary (e.g., for a graph-native provenance query engine), migrating from JSON properties to nodes requires a data migration. **Mitigation:** The materialization path (JSON-to-nodes) is straightforward and can be scripted. The reverse (nodes-to-JSON) is harder, which is why we are making this decision now rather than later.

## Alternatives Considered

### Alternative 1: Separate PropertyClaim Nodes (v0.2 Design)

- **Description:** Store every claim as a separate Neo4j node with label `PropertyClaim`, connected to its entity via `HAS_CLAIM` relationships. Each PropertyClaim node has properties: `propertyName`, `source`, `value`, `timestamp`, `confidence`, `evidence`.
- **Rejected because:** Creates 30x node count amplification, degrades query performance for the core `blast_radius` use case, adds write amplification for every connector sync, and complicates the Core Writer's resolution logic. The provenance/audit benefits do not justify the performance and complexity costs for Phase 1.

### Alternative 2: PostgreSQL-Only Claim Storage

- **Description:** Store entity nodes in Neo4j with resolved values only. Store all claims exclusively in PostgreSQL. The Core Writer reads claims from PostgreSQL, runs resolution, and writes resolved values to Neo4j.
- **Rejected because:** Introduces a hard dependency on PostgreSQL in Phase 1, which conflicts with the goal of a minimal Docker Compose stack (Neo4j + Redis + app). Also creates a consistency risk: if PostgreSQL and Neo4j diverge, the resolved values on entity nodes may not match the claims in PostgreSQL. The JSON-on-node approach keeps claims co-located with their entity, ensuring atomicity.

### Alternative 3: Neo4j Node Properties with Structured Maps

- **Description:** Instead of a JSON string, use Neo4j's native map properties to store claims. For example, `owner_claims: [{source: 'github', value: 'team-alpha', ...}]`.
- **Rejected because:** Neo4j does not support lists of maps as native property types. Lists must be of homogeneous scalar types (strings, integers, etc.). Storing structured claim data requires either JSON serialization (which is what this ADR proposes) or flattening into parallel arrays (`owner_claim_sources: ['github', 'backstage']`, `owner_claim_values: ['team-alpha', 'Team Alpha']`), which is fragile and hard to maintain.
