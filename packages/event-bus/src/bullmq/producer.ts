import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { CanonicalEntity, CanonicalNode, EventEnvelope } from '@shipit-ai/shared';
import type { ResolvedConfig } from '../config.js';

const EVENT_LOG_STREAM = 'shipit-event-log';

function buildIdempotencyKey(connectorId: string, node: CanonicalNode): string {
  return `${connectorId}:${node.id}:${node._event_version}`;
}

function buildEnvelopes(entities: CanonicalEntity[], connectorId: string): EventEnvelope[] {
  const envelopes: EventEnvelope[] = [];
  const now = new Date().toISOString();

  for (const entity of entities) {
    for (const node of entity.nodes) {
      envelopes.push({
        id: randomUUID(),
        timestamp: now,
        connector_id: connectorId,
        idempotency_key: buildIdempotencyKey(connectorId, node),
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
