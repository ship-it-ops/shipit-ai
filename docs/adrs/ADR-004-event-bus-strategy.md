# ADR-004: Tiered Event Bus: In-Process Queue for Small, Kafka for Production

## Status

Accepted

## Date

2026-02-28

## Context

ShipIt-AI connectors emit entity events (entity discovered, entity updated, entity deleted) that the Core Writer consumes and writes to Neo4j. The event bus sits between connectors and the Core Writer. The v0.2 design specified Apache Kafka as the event bus for all deployment sizes.

### The problem with Kafka-by-default

Kafka (or its lighter alternative, Redpanda) is a powerful distributed streaming platform, but it has a significant resource footprint:

- **Memory:** A single Kafka broker requires 1-2 GB of heap. ZooKeeper (for older Kafka versions) adds another 512 MB. Redpanda is more efficient but still requires 1-2 GB.
- **Disk:** Kafka retains messages on disk. Even with minimal retention, the broker writes data to log segments, requiring dedicated storage.
- **Docker Compose complexity:** Adding Kafka to Docker Compose means adding a broker container, configuring topics, setting retention policies, and waiting for the broker to become healthy before starting connectors. The health check alone adds 15-30 seconds to startup.
- **Operational overhead:** Kafka requires monitoring (consumer lag, partition rebalancing, disk usage), configuration tuning (batch sizes, compression, replication), and upgrades. For a team evaluating ShipIt-AI with 50-500 entities, this is disproportionate.

The total Docker Compose RAM for ShipIt-AI with Kafka would be:

| Service        | RAM         |
| -------------- | ----------- |
| Neo4j          | 1 GB        |
| Kafka/Redpanda | 1.5 GB      |
| Redis          | 256 MB      |
| App Server     | 512 MB      |
| **Total**      | **~3.5 GB** |

This excludes the frontend, any connectors running as separate processes, and the developer's own tools. On a 16 GB laptop, this is noticeable. On an 8 GB CI runner, it may fail.

### When Kafka is genuinely needed

Kafka's strengths become relevant at scale:

- **Replay:** Kafka retains messages, allowing the Core Writer to be rebuilt or a new consumer to replay historical events. This matters when schema changes require re-ingesting all data.
- **Partitioning:** Entity events can be partitioned by entity type or connector, allowing parallel consumers. This matters when the event volume exceeds what a single Core Writer can process.
- **Consumer groups:** Multiple consumers (Core Writer, audit logger, metrics exporter) can independently consume the same event stream. This matters in Enterprise deployments with multiple downstream systems.
- **Durability guarantees:** Kafka's replication and exactly-once semantics matter when data loss is unacceptable.

These strengths are irrelevant for a deployment with fewer than 1,000 entities where a single Core Writer can process all events in seconds.

## Decision

We will implement a **two-tier event bus architecture** with a common interface that abstracts the underlying transport.

### Event Bus Interface

All connectors and the Core Writer code against an `EventBus` TypeScript interface:

```typescript
interface EventBus {
  publish(topic: string, event: EntityEvent): Promise<void>;
  subscribe(topic: string, handler: (event: EntityEvent) => Promise<void>): Promise<Subscription>;
  healthCheck(): Promise<HealthStatus>;
}

interface EntityEvent {
  id: string; // Unique event ID (ULID)
  type: 'entity.discovered' | 'entity.updated' | 'entity.deleted' | 'relationship.discovered';
  entityType: string; // e.g., 'Service', 'Repository', 'Team'
  canonicalId: string; // Entity canonical ID
  source: string; // Connector source identifier
  connectorId: string; // Connector instance ID
  timestamp: string; // ISO 8601
  payload: Record<string, unknown>; // Entity data
}

interface Subscription {
  unsubscribe(): Promise<void>;
}
```

### Tier 1: Lite Mode (Default)

- **Backend:** BullMQ on Redis.
- **When:** Installations with fewer than ~1,000 entities, single-instance deployments, development/testing.
- **Trade-offs:** No replay (processed events are removed from the queue), no partitioning (single consumer), limited durability (Redis persistence). Adequate for the target scale.
- **RAM overhead:** ~0 MB additional (Redis is already required for caching and session storage).
- **Configuration:** `EVENT_BUS_BACKEND=bullmq` (default).

For development and testing, an in-memory queue implementation is also available:

- **Backend:** In-memory TypeScript queue (no external dependency).
- **When:** Unit tests, integration tests, local development without Docker.
- **Configuration:** `EVENT_BUS_BACKEND=memory`.

### Tier 2: Production Mode (Phase 2)

- **Backend:** Apache Kafka or Redpanda.
- **When:** Installations exceeding ~1,000 entities, multi-instance deployments, Enterprise tier, or when replay/audit is required.
- **Trade-offs:** Higher resource requirements, operational complexity, but provides replay, partitioning, consumer groups, and durability.
- **Configuration:** `EVENT_BUS_BACKEND=kafka`, plus `KAFKA_BROKERS`, `KAFKA_TOPIC_PREFIX`, etc.

### Tier 3: Cloud Queues (Phase 3)

- **Backend:** AWS SQS, Google Cloud Pub/Sub, Azure Service Bus.
- **When:** Cloud-native deployments where the team wants managed infrastructure.
- **Configuration:** `EVENT_BUS_BACKEND=sqs` / `pubsub` / `servicebus`.

### Phasing

| Phase    | Event Bus Backend         | Notes                                                               |
| -------- | ------------------------- | ------------------------------------------------------------------- |
| Phase 1a | In-memory queue           | Simplest possible; no Redis dependency for the queue itself         |
| Phase 1b | BullMQ on Redis           | Redis already in Docker Compose for caching; BullMQ adds durability |
| Phase 2  | Kafka/Redpanda (optional) | Available as an opt-in for large deployments                        |
| Phase 3  | Cloud queues (optional)   | SQS, Pub/Sub, Service Bus                                           |

### Implementation notes

- The `EventBus` interface lives in `@shipit-ai/event-bus` package.
- Each backend implementation (`BullMQEventBus`, `KafkaEventBus`, `MemoryEventBus`) is in its own file.
- The factory function `createEventBus(config)` reads the `EVENT_BUS_BACKEND` environment variable and returns the appropriate implementation.
- Connector authors never import a specific backend — they import `EventBus` from `@shipit-ai/event-bus`.

## Consequences

### Positive

- **Low barrier to entry.** `docker-compose up` starts Neo4j + Redis + App. No Kafka broker, no ZooKeeper, no topic configuration. Total RAM under 2 GB.
- **Fast startup.** The in-memory and BullMQ backends are ready in under 1 second. No waiting for Kafka broker health checks.
- **Connector portability.** Connector code is identical regardless of backend. A connector tested with the in-memory backend works unchanged on Kafka.
- **Progressive complexity.** Teams start simple and upgrade to Kafka only when they need replay, partitioning, or consumer groups. The upgrade is a configuration change, not a code change.
- **Testing simplicity.** The in-memory backend enables fast, deterministic integration tests without Docker or external services.

### Negative

- **No replay in Lite Mode.** If the Core Writer crashes mid-processing, events in the BullMQ queue are preserved (BullMQ has at-least-once delivery), but there is no Kafka-style replay from an offset. **Mitigation:** BullMQ supports failed job retention and retry. For Phase 1, connectors can re-sync if needed (they are polling-based, not push-based). Full replay capability comes with Kafka in Phase 2.
- **Interface abstraction cost.** The `EventBus` interface must be general enough to accommodate BullMQ, Kafka, and cloud queues. This may mean the interface cannot expose Kafka-specific features (partitioning control, consumer group management) without extension interfaces. **Mitigation:** The base interface covers publish/subscribe. Kafka-specific features are exposed via a `KafkaEventBus` subclass with additional methods, available when the backend is known.
- **Behavioral differences between backends.** BullMQ is a job queue (at-least-once, no ordering guarantees across workers). Kafka is a log (ordered within a partition, replay from offset). Code that relies on ordering may behave differently. **Mitigation:** The Core Writer must be idempotent regardless of backend (entity MERGE operations are naturally idempotent). Document ordering guarantees per backend.
- **Maintenance of multiple backends.** Each backend implementation must be maintained, tested, and documented. **Mitigation:** The interface is simple (publish, subscribe, health check). Each implementation is under 200 lines. The in-memory and BullMQ implementations share test suites via the common interface.

## Alternatives Considered

### Alternative 1: Kafka for All Deployment Sizes

- **Description:** Use Kafka (or Redpanda) as the single event bus backend for all deployments, including development and small installations.
- **Rejected because:** 1.5+ GB RAM overhead for the broker alone makes the getting-started experience painful. Developers evaluating ShipIt-AI on a laptop should not need to allocate 4+ GB to Docker Compose. The Kafka operational overhead (topic management, consumer lag monitoring, broker configuration) is disproportionate for installations with fewer than 1,000 entities.

### Alternative 2: Direct Function Calls (No Event Bus)

- **Description:** Connectors call the Core Writer directly via function calls or HTTP. No queue, no event bus interface. Simpler architecture.
- **Rejected because:** Tight coupling between connectors and the Core Writer. If the Core Writer is slow or down, connectors block or fail. No buffering, no retry, no backpressure. This also makes it impossible to add additional consumers (audit log, metrics) without modifying connectors. The event bus interface is a small abstraction that provides meaningful decoupling.

### Alternative 3: Redis Streams (Without BullMQ)

- **Description:** Use Redis Streams directly as the Lite Mode backend. Redis Streams support consumer groups, message acknowledgment, and replay (via `XRANGE`).
- **Rejected because:** Redis Streams are lower-level than BullMQ. BullMQ provides retry logic, dead-letter queues, rate limiting, concurrency control, and a dashboard (Bull Board) out of the box. Reimplementing these features on raw Redis Streams is unnecessary work. BullMQ is built on Redis and provides a mature, well-tested job queue abstraction. If Redis Streams' replay capability is needed, Phase 2's Kafka support is the answer.

### Alternative 4: NATS

- **Description:** Use NATS as a lightweight alternative to Kafka. NATS is fast, small (30 MB binary), and supports pub/sub, request/reply, and JetStream for persistence.
- **Rejected because:** NATS is an excellent technology but adds another service to the Docker Compose stack. BullMQ on Redis adds zero additional services (Redis is already required). NATS JetStream would be a viable alternative to Kafka in Phase 2, but introducing it for Lite Mode is unnecessary complexity.
