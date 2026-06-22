import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import type {
  CanonicalEdge,
  CanonicalEntity,
  CanonicalNode,
  EventEnvelope,
} from '@shipit-ai/shared';
import { deriveNodeContentHash } from '@shipit-ai/shared';
import type { ResolvedConfig } from '../config.js';
import { FAILED_JOB_RETENTION } from './retention.js';

const EVENT_LOG_STREAM = 'shipit-event-log';

function buildIdempotencyKey(connectorId: string, node: CanonicalNode): string {
  // Cut B (Option B): dedup on the node's CONTENT fingerprint, not `_event_version`
  // (which is now only the ordering token). A content change that does not advance
  // the source timestamp must still get a fresh key and reach the writer's freshness
  // guard. MUST match core-writer `idempotency.ts buildNodeIdempotencyKey` (same
  // `deriveNodeContentHash`) so the queue layer and the _IdempotencyLog agree.
  //
  // BullMQ 5 rejects `:` in custom job IDs — it reserves the colon for its internal
  // `bull:<queue>:<key>` keyspace and `Queue.addBulk` throws synchronously if any
  // opts.jobId contains one. Canonical IDs use the `shipit://...` URI scheme, and the
  // content hash is hex (colon-free); we substitute `~` globally to be safe.
  return `${connectorId}:${node.id}:${deriveNodeContentHash(node)}`.replace(/:/g, '~');
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
  private readonly eventLogEnabled: boolean;
  private readonly eventLogMaxLen: number;

  constructor(config: ResolvedConfig) {
    this.queue = new Queue(config.queueName, {
      connection: { host: config.redisHost, port: config.redisPort, maxRetriesPerRequest: null },
      // Bound retention so Redis doesn't grow forever (2026-06-17 OOM
      // incident). Completed event jobs are removed immediately — the
      // event-log stream is the audit trail — but failed jobs are kept a
      // bounded window for debugging instead of the old `removeOnFail: false`.
      defaultJobOptions: { removeOnComplete: true, removeOnFail: FAILED_JOB_RETENTION },
    });
    this.streamRedis = new Redis(config.redisPort, config.redisHost, {
      maxRetriesPerRequest: null,
    });
    this.retentionDays = config.retentionDays;
    this.eventLogEnabled = config.eventLogEnabled;
    this.eventLogMaxLen = config.eventLogMaxLen;

    // A BullMQ Queue / ioredis client is an EventEmitter; an emitted 'error'
    // with NO listener rethrows as an uncaughtException and kills the process.
    // When Redis is at `maxmemory` (noeviction), writes fail with `OOM command
    // not allowed` — this must DEGRADE the event bus, not crash the host
    // process (the 2026-06-22 api-server crashloop). Log, never rethrow; the
    // publish() path already propagates write rejections to the caller for
    // BullMQ retry.
    this.queue.on('error', (err: Error) => {
      console.warn(`EventBus producer queue Redis error (publish degraded): ${err.message}`);
    });
    this.streamRedis.on('error', (err: Error) => {
      console.warn(`EventBus producer stream Redis error (publish degraded): ${err.message}`);
    });
  }

  async publish(events: CanonicalEntity[], connectorId: string): Promise<void> {
    const envelopes = buildEnvelopes(events, connectorId);

    const jobs = envelopes.map((env) => ({
      name: 'event',
      data: env,
      opts: {
        jobId: env.idempotency_key,
        // Retention inherited from the queue's defaultJobOptions.
      },
    }));

    if (jobs.length > 0) {
      await this.queue.addBulk(jobs);
    }

    // Write to the `shipit-event-log` Redis Stream for replay support — ONLY
    // when explicitly enabled. This stream stores the full event JSON per
    // envelope and is read solely by `replay()`, which nothing currently calls;
    // left on, a time-bounded-only stream is unbounded in bytes and grew to
    // ~825 MB (the dominant share of the 2026-06-22 Redis OOM crashloop). When
    // enabled it is bounded by BOTH a hard size ceiling (`MAXLEN ~`) and the
    // retention-day time trim so it can never blow the maxmemory ceiling again.
    // See the replay-stream-wire-or-cut open question.
    if (this.eventLogEnabled && envelopes.length > 0) {
      const pipeline = this.streamRedis.pipeline();
      for (const env of envelopes) {
        // `MAXLEN ~ n` caps the stream at ~n entries, trimming inline on every
        // add (the `~` makes trimming amortized/cheap). Bytes = entries ×
        // event size, so the count cap is what bounds the working set.
        pipeline.xadd(
          EVENT_LOG_STREAM,
          'MAXLEN',
          '~',
          this.eventLogMaxLen,
          '*',
          'data',
          JSON.stringify(env),
        );
      }

      // Secondary, time-based trim: drop anything older than the retention
      // window even if the count cap hasn't been reached.
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
