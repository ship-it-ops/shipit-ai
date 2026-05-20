# ADR-007: Neo4j High Availability Strategy

## Status

Accepted

## Date

2026-02-28

## Context

Neo4j is the central data store for ShipIt-AI, serving both the Core Writer (write path) and the MCP server (read path for AI agent queries). This makes it a single point of failure for the entire system. The product is explicitly marketed as a tool to "query during incidents" -- any Neo4j downtime during an active incident destroys user trust and eliminates the product's core value proposition.

The availability requirements differ significantly between deployment tiers:

- **Community tier** users are cost-sensitive and typically run smaller installations. Neo4j Community Edition does not support clustering, causal clustering, read replicas, or online backup (`neo4j-admin backup` requires the database to be stopped in Community Edition). These are Enterprise-only features.
- **Enterprise tier** users operate at scale, have strict SLA requirements, and are willing to pay for high availability. They cannot tolerate any single point of failure during incident response.

Additionally, the read and write paths have different availability characteristics:

- **Write path (Core Writer):** Ingests data from connectors via the event bus. Temporary write unavailability is tolerable because the event bus (Kafka/Redis Streams) provides buffering with 7-day retention. Writes can be replayed after recovery.
- **Read path (MCP server):** Serves AI agent queries in real-time during incidents. Read unavailability is immediately visible to users and directly impacts incident response. Silent timeouts are especially dangerous -- an AI agent that hangs waiting for Neo4j gives no useful signal to the operator.

The system must degrade gracefully when Neo4j is unavailable, providing clear error signals rather than silent failures.

## Decision

We will implement a tiered high availability strategy for Neo4j, with different approaches for Community and Enterprise tiers.

### Community Tier: Single Instance with Automated Backup and Documented Recovery

1. **Single Neo4j Community Edition instance.** No clustering or read replicas are available in Community Edition. This is an acknowledged and documented availability gap.

2. **Automated backup every 6 hours** using `neo4j-admin dump` to a mounted volume (e.g., an NFS share or cloud storage bucket). The backup schedule is configurable via environment variable `NEO4J_BACKUP_INTERVAL_HOURS` (default: 6). Backups are performed by a sidecar container or cron job that:
   - Stops the Neo4j instance briefly (Community Edition requires offline backup).
   - Runs `neo4j-admin dump --database=neo4j --to=/backups/neo4j-$(date +%Y%m%d%H%M%S).dump`.
   - Retains the last 14 backups (configurable via `NEO4J_BACKUP_RETENTION_COUNT`).
   - Restarts Neo4j.
   - Logs backup success/failure to the application log and emits a health metric.

3. **Documented restore procedure** published in the operations runbook:
   - Stop the Neo4j instance.
   - Run `neo4j-admin load --from=/backups/<selected-backup>.dump --database=neo4j --force`.
   - Start Neo4j.
   - Replay events from the event bus (7-day retention) to recover data ingested since the last backup.
   - Verify graph integrity via the `schema_info` MCP tool.

4. **Event bus replay as disaster recovery.** Because the event bus retains events for 7 days, a complete Neo4j rebuild is possible by replaying all retained events into a fresh instance. This serves as the ultimate disaster recovery mechanism.

### Enterprise Tier: Neo4j Enterprise Edition with Causal Clustering

1. **Neo4j Enterprise Edition** (self-hosted) or **Neo4j Aura Professional** (managed) with causal clustering enabled.

2. **Cluster topology:**
   - Minimum 3 core members for write quorum (tolerates 1 failure).
   - 1 or more read replicas dedicated to MCP query serving.
   - Write leader handles all Core Writer transactions.
   - Read replicas handle all MCP server queries.

3. **MCP server targeting:**
   - The MCP server is configured to route queries to read replicas via the `neo4j://` bolt routing protocol with `?policy=read` session configuration.
   - A configurable staleness tolerance (`MCP_READ_STALENESS_MS`, default: 5000ms) allows read replicas to lag behind the write leader by up to this threshold before triggering a `stale` freshness warning in the MCP response envelope (see ADR-008).

4. **Online backup** using `neo4j-admin backup` (Enterprise feature) without downtime, scheduled every 6 hours, stored in the configured backup volume or cloud storage.

### Both Tiers: Graceful Degradation on Neo4j Unavailability

1. **MCP server behavior when Neo4j is unreachable:**
   - Returns a structured error response (not a timeout) within 3 seconds:
     ```json
     {
       "error": {
         "code": "GRAPH_UNAVAILABLE",
         "message": "Knowledge graph is temporarily unavailable.",
         "last_known_good": "2026-02-28T02:15:00Z",
         "suggestions": [
           "Retry in 30 seconds",
           "Check Neo4j health endpoint at /health/neo4j",
           "Consult the operations runbook for recovery procedures"
         ]
       }
     }
     ```
   - The `last_known_good` timestamp is maintained in-memory by the MCP server from the last successful query, enabling the AI agent to communicate data age to the user.

2. **Health check endpoint** (`/health/neo4j`) exposed by the MCP server, returning Neo4j connection status, cluster topology (Enterprise), and last successful query timestamp.

3. **Core Writer behavior when Neo4j is unreachable:**
   - Pauses event consumption from the event bus (messages remain buffered).
   - Retries connection with exponential backoff (1s, 2s, 4s, ..., max 60s).
   - Emits `neo4j.write.unavailable` metric for alerting.
   - Resumes consumption and processing when connectivity is restored.

## Consequences

### Positive

- **Enterprise tier achieves full HA** with no single point of failure for either reads or writes. Read replicas can be scaled independently to handle query load during major incidents.
- **Community tier has a clear recovery path** even without clustering. The 6-hour backup interval combined with 7-day event bus replay means maximum data loss is bounded and recoverable.
- **Graceful degradation prevents silent failures.** AI agents receive explicit error signals with actionable information rather than hanging on timeouts, which is critical during incident response when operators are under stress.
- **Clear Enterprise value proposition.** The availability gap in Community tier creates a genuine, well-understood reason to upgrade, rather than an artificial limitation.
- **Event bus replay as disaster recovery** provides a safety net that does not depend on backup integrity.

### Negative

- **Community tier has acknowledged downtime during backups.** The `neo4j-admin dump` command requires stopping the database, causing a brief outage (typically 30-120 seconds depending on database size). This must be scheduled during low-usage windows.
- **Community tier is a single point of failure.** During an incident, if Neo4j also goes down, the knowledge graph is unavailable. This is a known limitation documented in the tier comparison.
- **Enterprise tier adds operational complexity.** Causal clustering requires monitoring cluster health, managing leader elections, and understanding transaction routing. This is mitigated by using Neo4j Aura Professional (managed) as the recommended option.
- **Read replica staleness is a tradeoff.** MCP queries may return data up to `MCP_READ_STALENESS_MS` behind the write leader. The MCP response envelope (ADR-008) mitigates this by surfacing freshness status explicitly.
- **Backup storage costs.** Retaining 14 full database dumps requires storage proportional to 14x the database size. For large graphs this may be significant.

## Alternatives Considered

### Alternative 1: Run Neo4j Enterprise Edition for All Tiers

- **Description:** Require Neo4j Enterprise Edition (or Aura) for all deployments, including Community tier, to provide HA universally.
- **Rejected because:** Neo4j Enterprise Edition licensing is expensive and would make the Community tier economically unviable. The whole point of the Community tier is low barrier to entry. Users who need HA can upgrade to Enterprise tier.

### Alternative 2: Replace Neo4j with a Distributed Graph Database (e.g., JanusGraph, TigerGraph)

- **Description:** Use a graph database that supports distributed clustering natively in its open-source edition.
- **Rejected because:** Neo4j has the largest ecosystem, best Cypher tooling, strongest AI/LLM integration support, and the most mature MCP-compatible drivers. Switching graph databases would require rewriting the entire query layer, ontology, and connector logic. The HA gap is solvable at the tier level without abandoning Neo4j.

### Alternative 3: Application-Level Read Caching (Redis/In-Memory) in Front of Neo4j

- **Description:** Cache frequently-read subgraphs in Redis or an in-memory store to reduce Neo4j read load and provide read availability when Neo4j is down.
- **Rejected because:** Graph queries are highly variable (blast radius from any node, dependency chains of arbitrary depth). Caching would require complex invalidation logic and would likely serve stale data without the transparency that the MCP response envelope provides. The complexity is not justified when Enterprise tier clustering solves the read scaling problem natively. However, this may be revisited in a future ADR if specific hot-path queries emerge.

### Alternative 4: Neo4j Community Edition with File System Snapshots Instead of neo4j-admin dump

- **Description:** Use filesystem-level snapshots (e.g., LVM snapshots, ZFS snapshots, EBS snapshots) instead of `neo4j-admin dump` to avoid stopping the database during backup.
- **Rejected because:** Filesystem snapshots of a running Neo4j instance can produce inconsistent backups unless Neo4j is in a quiescent state. The `neo4j-admin dump` approach, while requiring a brief stop, guarantees consistency. For environments where even brief downtime is unacceptable, the answer is Enterprise tier, not risky backup shortcuts.
