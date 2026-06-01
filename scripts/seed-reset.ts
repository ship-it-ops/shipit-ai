/**
 * Clears all *data* state from the ShipIt-AI dev environment:
 *
 *   1. Neo4j      — every node + relationship (domain + internal bookkeeping
 *                   like `_LinkingKey` and `_IdempotencyLog`).
 *   2. Redis      — connector run history (`shipit:connector-runs:*`).
 *   3. BullMQ     — every job + state for the event-bus and sync-scheduler
 *                   queues. Otherwise pending events replay after restart and
 *                   silently re-populate Neo4j, which looks exactly like
 *                   "stale data survived a reset".
 *
 * Configuration in `shipit.config.local.yaml` (connector instances, GitHub
 * App credentials, schedule, scope) is deliberately preserved — re-onboarding
 * a GitHub App is expensive, and the next connector tick will repopulate
 * Neo4j from the same source of truth.
 *
 * Schema history under `schema-history/` is also preserved (it's an audit
 * trail of intentional schema edits, not connector data).
 *
 * Refuses to run when `NODE_ENV=production` unless `--force-production` is
 * passed. Honors `--yes` for non-interactive use (e.g. CI).
 *
 * Usage: pnpm seed:reset
 *        pnpm seed:reset -- --yes
 *        NODE_ENV=production pnpm seed:reset -- --force-production --yes
 */
import { createInterface } from 'node:readline/promises';
import neo4j from 'neo4j-driver';
import Redis from 'ioredis';

const NEO4J_URI = process.env['NEO4J_URI'] ?? 'bolt://localhost:7687';
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? 'shipit-dev';
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

// Kept in sync with the source-of-truth queue names. If either of these
// changes, this script silently leaves pending jobs in Redis and the next
// boot will replay them.
//
//   - event-bus → `packages/event-bus/src/config.ts` (DEFAULT_CONFIG.queueName)
//   - sync-scheduler → `packages/api-server/src/services/sync-scheduler.ts`
//     (DEFAULT_QUEUE)
const BULL_QUEUES = ['shipit-events', 'shipit-sync-github'] as const;

// Connector run history — `packages/api-server/src/services/connector-run-store.ts`
// (KEY_PREFIX).
const CONNECTOR_RUN_KEY_PATTERN = 'shipit:connector-runs:*';

export interface ResetGuardOpts {
  nodeEnv: string | undefined;
  forceProduction: boolean;
}

/**
 * Hard-refuses when running in production without an explicit override.
 * Exported for unit testing — the rest of the script is integration-level.
 */
export function assertNotProduction(opts: ResetGuardOpts): void {
  if (opts.nodeEnv === 'production' && !opts.forceProduction) {
    throw new Error(
      'Refusing to wipe data: NODE_ENV=production. Pass --force-production if you really mean it.',
    );
  }
}

interface CliFlags {
  yes: boolean;
  forceProduction: boolean;
}

function parseFlags(argv: readonly string[]): CliFlags {
  return {
    yes: argv.includes('--yes') || argv.includes('-y'),
    forceProduction: argv.includes('--force-production'),
  };
}

async function confirm(): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = await rl.question(
      'About to wipe Neo4j + connector run history + BullMQ queues. Type "wipe" to confirm: ',
    );
    return ans.trim() === 'wipe';
  } finally {
    rl.close();
  }
}

async function wipeNeo4j(): Promise<number> {
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));
  try {
    await driver.verifyConnectivity();
    const session = driver.session();
    try {
      const result = await session.run('MATCH (n) DETACH DELETE n RETURN count(n) AS deleted');
      const deleted = result.records[0]?.get('deleted');
      return typeof deleted === 'object' && deleted?.toNumber
        ? deleted.toNumber()
        : Number(deleted);
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
}

async function delByPattern(redis: Redis, pattern: string): Promise<number> {
  // SCAN over KEYS: KEYS is O(N) on a single thread and blocks the server;
  // SCAN iterates with a cursor so the reset doesn't latency-spike anything
  // else hitting Redis (the BullMQ workers in particular). Batch UNLINK
  // instead of DEL so the deletion happens asynchronously and we don't wait
  // on potentially-large hash drops one-by-one.
  let cursor = '0';
  let deleted = 0;
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = next;
    if (batch.length > 0) {
      deleted += batch.length;
      await redis.unlink(...batch);
    }
  } while (cursor !== '0');
  return deleted;
}

async function wipeRedis(): Promise<{ runHistory: number; bullByQueue: Record<string, number> }> {
  const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
  try {
    const runHistory = await delByPattern(redis, CONNECTOR_RUN_KEY_PATTERN);
    const bullByQueue: Record<string, number> = {};
    for (const queue of BULL_QUEUES) {
      // BullMQ stores everything under `bull:<queue>:*`. Plain SCAN+UNLINK is
      // sufficient — we don't need Queue.obliterate's Lua script because we
      // want every trace gone, not just a graceful drain.
      bullByQueue[queue] = await delByPattern(redis, `bull:${queue}:*`);
    }
    return { runHistory, bullByQueue };
  } finally {
    await redis.quit();
  }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  assertNotProduction({ nodeEnv: process.env['NODE_ENV'], forceProduction: flags.forceProduction });

  if (!flags.yes) {
    const ok = await confirm();
    if (!ok) {
      console.log('Aborted.');
      return;
    }
  }

  console.log(`Connecting to Neo4j at ${NEO4J_URI}`);
  const neo4jDeleted = await wipeNeo4j();
  console.log(`  Neo4j: deleted ${neo4jDeleted} nodes (and all relationships)`);

  console.log(`Connecting to Redis at ${REDIS_URL}`);
  const { runHistory, bullByQueue } = await wipeRedis();
  console.log(`  Redis: cleared ${runHistory} connector-run keys`);
  for (const [queue, count] of Object.entries(bullByQueue)) {
    console.log(`  Redis: cleared ${count} keys from BullMQ queue \`${queue}\``);
  }

  console.log('\nDone. Connector configuration in shipit.config.local.yaml is preserved.');
}

// Only run when invoked as a script — keeps the module importable in tests.
const isDirectInvocation = (() => {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return import.meta.url === new URL(`file://${arg}`).href;
  } catch {
    return false;
  }
})();

if (isDirectInvocation) {
  main().catch((err) => {
    console.error('Reset failed:', err);
    process.exit(1);
  });
}
