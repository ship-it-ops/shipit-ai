// Entry point for the knowledge-worker process: claims pending documents from
// Postgres, chunks and embeds them through Vertex AI, writes the chunks back,
// and heartbeats to Redis so /api/knowledge/status can see it. Boots like
// core-writer: thin, fails loudly on a missing prerequisite, degrades on a
// transient one.
import { Redis } from 'ioredis';
import { createDb, createPool } from '@shipit-ai/agents';
import {
  INDEX_VERSION,
  IndexLoop,
  KnowledgeStore,
  hasVectorExtension,
  missingKnowledgeMigrations,
} from '@shipit-ai/knowledge';
import { loadConfig } from '@shipit-ai/shared';
import { VertexEmbedder } from './vertex-embedder.js';

export const HEARTBEAT_KEY = 'shipit-knowledge-worker-heartbeat';
export const WAKE_CHANNEL = 'shipit-knowledge-wake';

async function main(): Promise<void> {
  const config = loadConfig();
  const { knowledge, ai } = config;

  if (!knowledge.enabled) {
    // A promise with no handle behind it lets Node exit; hold a timer so the
    // pod stays Running (a Deployment would otherwise restart-loop) until a
    // signal arrives.
    console.log('knowledge-worker: knowledge.enabled is false; idling so the pod stays healthy.');
    await new Promise<void>((resolve) => {
      const keepAlive = setInterval(() => undefined, 60_000);
      const stop = (signal: string): void => {
        console.log(`knowledge-worker received ${signal} while idle, exiting.`);
        clearInterval(keepAlive);
        resolve();
      };
      process.once('SIGTERM', () => stop('SIGTERM'));
      process.once('SIGINT', () => stop('SIGINT'));
    });
    return;
  }
  if (!ai.database.url) {
    console.error('knowledge-worker: ai.database.url (DATABASE_URL) is empty. Exiting.');
    process.exit(1);
  }
  if (!ai.vertex.project) {
    console.error('knowledge-worker: ai.vertex.project (GOOGLE_CLOUD_PROJECT) is empty. Exiting.');
    process.exit(1);
  }
  if (knowledge.embedding.dimensions !== 768) {
    console.error(
      `knowledge-worker: knowledge.embedding.dimensions is ${knowledge.embedding.dimensions}; the schema is halfvec(768). Exiting.`,
    );
    process.exit(1);
  }

  const pool = createPool({
    connectionString: ai.database.url,
    max: knowledge.worker.concurrency + 2,
    // Chunk inserts for a long document and HNSW maintenance can exceed 10 s.
    statementTimeoutMs: 60_000,
    onError: (err) => console.error(`knowledge-worker: postgres pool error: ${err.message}`),
  });
  const db = createDb(pool);

  const missing = await missingKnowledgeMigrations(db).catch((err: Error) => {
    console.error(`knowledge-worker: cannot read schema_migrations: ${err.message}`);
    return null;
  });
  const extensionPresent = await hasVectorExtension(db).catch(() => false);
  if (missing === null || missing.length > 0 || !extensionPresent) {
    console.error(
      `knowledge-worker: the database is not ready (missing migrations: ${missing?.join(', ') || 'none'}; ` +
        `vector extension: ${extensionPresent}). Exiting; the deployment restarts me after the migration step.`,
    );
    await pool.end();
    process.exit(1);
  }

  const store = new KnowledgeStore(db);
  const embedder = new VertexEmbedder({
    project: ai.vertex.project,
    location: ai.vertex.location,
    model: knowledge.embedding.model,
    dimensions: knowledge.embedding.dimensions,
    // The loop already indexes `concurrency` documents at once; keep each
    // document's own fan-out small so the two do not multiply into a 429 storm.
    maxParallelCalls: 2,
  });

  // Container names for chunk prefixes, cached per process.
  const containerNames = new Map<string, string>();
  const containerNameOf = async (containerId: string): Promise<string> => {
    const cached = containerNames.get(containerId);
    if (cached) return cached;
    const { rows } = await db.query<{ name: string }>(
      'SELECT name FROM knowledge_containers WHERE id = $1',
      [containerId],
    );
    const name = rows[0]?.name ?? '';
    containerNames.set(containerId, name);
    return name;
  };

  let redis: Redis | null = null;
  let subscriber: Redis | null = null;
  if (config.backend.redis.url) {
    redis = new Redis(config.backend.redis.url, { maxRetriesPerRequest: null });
    subscriber = new Redis(config.backend.redis.url, { maxRetriesPerRequest: null });
    for (const client of [redis, subscriber]) {
      client.on('error', (err: Error) =>
        console.warn(`knowledge-worker: redis error (degraded, polling continues): ${err.message}`),
      );
    }
  } else {
    console.warn(
      'knowledge-worker: backend.redis.url is empty; no heartbeat and no wake-ups, polling only.',
    );
  }

  const heartbeatRedis = redis;
  const loop = new IndexLoop({
    store,
    pipeline: {
      store,
      embedder,
      chunking: {
        chunkTokens: knowledge.index.chunkTokens,
        maxChunkTokens: knowledge.index.maxChunkTokens,
      },
      indexVersion: INDEX_VERSION,
      containerNameOf,
    },
    batchSize: knowledge.worker.batchSize,
    concurrency: knowledge.worker.concurrency,
    heartbeat: heartbeatRedis
      ? {
          sink: {
            set: async (key, value, ttl) => {
              await heartbeatRedis.set(key, value, 'EX', ttl);
            },
          },
          key: HEARTBEAT_KEY,
          ttlSeconds: 60,
          everyMs: 15_000,
        }
      : undefined,
    log: (line) => console.warn(`knowledge-worker: ${line}`),
  });

  if (subscriber) {
    await subscriber
      .subscribe(WAKE_CHANNEL)
      .catch((err: Error) =>
        console.warn(`knowledge-worker: could not subscribe to ${WAKE_CHANNEL}: ${err.message}`),
      );
    subscriber.on('message', () => loop.kick());
  }

  loop.start();
  console.log(
    `knowledge-worker: indexing with ${knowledge.embedding.model} (${knowledge.embedding.dimensions}d), ` +
      `batch ${knowledge.worker.batchSize}, concurrency ${knowledge.worker.concurrency}`,
  );

  // Tombstones older than the retention window, once a day.
  const DAY_MS = 24 * 60 * 60 * 1000;
  const cleanup = async (): Promise<void> => {
    try {
      const removed = await store.deleteTombstonesOlderThan(knowledge.retention.tombstoneDays);
      if (removed > 0) console.log(`knowledge-worker: removed ${removed} tombstone(s)`);
    } catch (err) {
      console.error(`knowledge-worker: tombstone cleanup failed: ${(err as Error).message}`);
    }
  };
  void cleanup();
  const cleanupTimer = setInterval(() => void cleanup(), DAY_MS);
  cleanupTimer.unref?.();

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`knowledge-worker received ${signal}, shutting down...`);
    try {
      clearInterval(cleanupTimer);
      await loop.stop();
      subscriber?.disconnect();
      redis?.disconnect();
      await pool.end();
    } catch (err) {
      console.error(`knowledge-worker shutdown error: ${(err as Error).message}`);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main().catch((err) => {
  console.error('knowledge-worker crashed during startup:', err);
  process.exit(1);
});
