// Entry point for the agent-runner process (design §Packages and processes).
// It works the runs the api-server queues: calls models on Vertex AI, runs the
// tools each agent is granted, and records everything in Postgres.
//
// Like core-writer/src/main.ts, this file only wires production adapters into
// the parts the suites test with fakes. A missing agent prerequisite never
// stops the process (design §Feature gating): it logs why and waits, and GET
// /ai/status shows the runner as down until it is working.
import { hostname } from 'node:os';
import { Redis } from 'ioredis';
import {
  createDb,
  createPool,
  EXPECTED_SCHEMA_VERSION,
  RunQueue,
  RunStore,
} from '@shipit-ai/agents';
import { createNeo4jClient } from '@shipit-ai/mcp-server/tools';
import { loadConfig } from '@shipit-ai/shared';
import { AgentLoop } from './loop/agent-loop.js';
import { VertexModelClient } from './model/vertex-model-client.js';
import { Housekeeping } from './process/housekeeping.js';
import { waitForSchema } from './process/prerequisites.js';
import { RedisRunEvents } from './process/run-events.js';
import { RunWorker } from './process/run-worker.js';
import { graphTools } from './tools/graph-tools.js';

function idle(reason: string): void {
  console.warn(`Agent runner idle: ${reason}.`);
  // Stay up so the Deployment does not crash-loop; a config change restarts the pod.
  setInterval(() => {}, 1 << 30);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const { ai } = config;
  if (!ai.enabled) return idle('ai.enabled is false');
  if (!ai.database.url) return idle('ai.database.url is empty');
  if (!config.backend.redis.url) return idle('backend.redis.url is empty');
  if (!ai.vertex.project)
    console.warn('Agent runner: ai.vertex.project is empty; model calls will fail.');

  const pool = createPool({
    connectionString: ai.database.url,
    max: ai.runner.concurrency + 2,
    onError: (err) => console.error(`Agent runner Postgres pool error: ${err.message}`),
  });
  const db = createDb(pool);
  await waitForSchema(db, EXPECTED_SCHEMA_VERSION);

  const owner = `${hostname()}-${process.pid}`;
  const redis = new Redis(config.backend.redis.url, { maxRetriesPerRequest: null });
  redis.on('error', (err: Error) => console.warn(`Agent runner Redis error: ${err.message}`));
  const events = new RedisRunEvents(redis);
  const runs = new RunStore(db);
  const neo4j = createNeo4jClient(
    config.backend.neo4j.uri,
    config.backend.neo4j.user,
    config.backend.neo4j.password,
  );

  const loop = new AgentLoop({
    runs,
    model: new VertexModelClient({ project: ai.vertex.project, location: ai.vertex.location }),
    tools: graphTools(neo4j, { rateLimits: config.backend.mcp.rateLimits }),
    models: ai.models,
    ceilings: ai.limits,
    toolResultChars: ai.limits.toolResultChars,
    owner,
    publish: (event) => events.publish(event),
  });
  const queue = new RunQueue({ redisUrl: config.backend.redis.url });
  const worker = new RunWorker({
    redisUrl: config.backend.redis.url,
    concurrency: ai.runner.concurrency,
    runtime: loop,
  });
  const housekeeping = new Housekeeping({
    runs,
    redis,
    queue,
    publish: (event) => events.publish(event),
    chatIdleMinutes: ai.limits.chatIdleMinutes,
  });
  housekeeping.start();
  console.log(
    `Agent runner ${owner} working (concurrency ${ai.runner.concurrency}, ${ai.models.length} models).`,
  );

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Agent runner received ${signal}, shutting down...`);
    try {
      housekeeping.stop();
      // Waits for runs in progress; a run cut off later resumes on another worker.
      await worker.close();
      await queue.close();
      await redis.quit();
      await neo4j.close();
      await pool.end();
    } catch (err) {
      console.error(`Agent runner shutdown error: ${(err as Error).message}`);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main().catch((err) => {
  console.error('Agent runner crashed during startup:', err);
  process.exit(1);
});
