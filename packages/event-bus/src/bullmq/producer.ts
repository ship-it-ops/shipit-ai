import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import type {
  CanonicalEdge,
  CanonicalEntity,
  CanonicalNode,
  EventEnvelope,
} from '@shipit-ai/shared';
import type { ResolvedConfig } from '../config.js';

const EVENT_LOG_STREAM = 'shipit-event-log';

function buildIdempotencyKey(connectorId: string, node: CanonicalNode): string {
  // BullMQ 5 rejects `:` in custom job IDs — it reserves the colon for
  // its internal `bull:<queue>:<key>` keyspace and `Queue.addBulk` throws
  // synchronously if any opts.jobId contains one. Canonical IDs use the
  // `shipit://...` URI scheme so the natural format would carry several
  // colons per entity. We substitute `~` globally; the key is opaque to
  // downstream consumers (used only for dedup + replay correlation).
  return `${connectorId}:${node.id}:${node._event_version}`.replace(/:/g, '~');
}

function buildEdgeBatchIdempotencyKey(connectorId: string, edges: CanonicalEdge[]): string {
  // Stable, content-derived key so re-syncing the same edge batch dedupes at
  // the BullMQ layer (jobId). Sort to make order-independent: a connector
  // emitting the same edges in different order should produce the same key.
  const tuples = edges
    .map((e) => `${e.from}|${e.to}|${e.type}`)
    .sort()
    .join(';');
  const hash = createHash('sha256').update(tuples).digest('hex').slice(0, 16);
  return `${connectorId}:edges:${hash}`.replace(/:/g, '~');
}

function buildEnvelopes(entities: CanonicalEntity[], connectorId: string): EventEnvelope[] {
  const envelopes: EventEnvelope[] = [];
  const now = new Date().toISOString();

  for (const entity of entities) {
    if (entity.nodes.length > 0) {
      // One envelope per node — payload carries the whole entity so the
      // writer sees both nodes and edges. Idempotency key is per-node so
      // BullMQ dedupes at the entity-membership level.
      for (const node of entity.nodes) {
        envelopes.push({
          id: randomUUID(),
          timestamp: now,
          connector_id: connectorId,
          idempotency_key: buildIdempotencyKey(connectorId, node),
          payload: entity,
        });
      }
    } else if (entity.edges.length > 0) {
      // Edge-only entity (e.g., a Codeowners batch normalizes to edges with
      // no new nodes). Without this branch the entity is silently dropped
      // before it ever reaches the event bus.
      envelopes.push({
        id: randomUUID(),
        timestamp: now,
        connector_id: connectorId,
        idempotency_key: buildEdgeBatchIdempotencyKey(connectorId, entity.edges),
        payload: entity,
      });
    }
  }

  return envelopes;
}

export class EventBusProducer {
  private readonly queue: Queue;
  private readonly streamRedis: Redis;
  private readonly retentionDays: number;

  constructor(config: ResolvedConfig) {
    this.queue = new Queue(config.queueName, {
      connection: { host: config.redisHost, port: config.redisPort, maxRetriesPerRequest: null },
    });
    this.streamRedis = new Redis(config.redisPort, config.redisHost, {
      maxRetriesPerRequest: null,
    });
    this.retentionDays = config.retentionDays;
  }

  async publish(events: CanonicalEntity[], connectorId: string): Promise<void> {
    const envelopes = buildEnvelopes(events, connectorId);

    const jobs = envelopes.map((env) => ({
      name: 'event',
      data: env,
      opts: {
        jobId: env.idempotency_key,
        removeOnComplete: true,
        removeOnFail: false,
      },
    }));

    if (jobs.length > 0) {
      await this.queue.addBulk(jobs);
    }

    // Write to Redis Stream for replay support
    if (envelopes.length > 0) {
      const pipeline = this.streamRedis.pipeline();
      for (const env of envelopes) {
        pipeline.xadd(EVENT_LOG_STREAM, '*', 'data', JSON.stringify(env));
      }

      // Trim stream by retention period
      const minTimestamp = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
      pipeline.xtrim(EVENT_LOG_STREAM, 'MINID', String(minTimestamp));

      await pipeline.exec();
    }
  }

  async close(): Promise<void> {
    await this.queue.close();
    this.streamRedis.disconnect();
  }
}

export { buildIdempotencyKey, buildEnvelopes, EVENT_LOG_STREAM };
