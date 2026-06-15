// Entry point for the core-writer process. Subscribes to the BullMQ event
// bus that the api-server's SyncScheduler publishes to, batches incoming
// envelopes, and writes the resulting nodes/edges into Neo4j via the
// CoreWriter pipeline (resolver → reconciler → idempotency → writer).
//
// This file is intentionally thin: it constructs the production-side
// adapters (Neo4jNodeWriter / Neo4jLinkingKeyIndex / Neo4jIdempotencyChecker)
// and hands them to the same CoreWriter the unit tests exercise with
// in-memory fakes. Until this process is running, sync runs would complete
// "successfully" at the connector layer but the entities would sit in the
// `bull:shipit-events:*` queue forever and never reach the graph.
import { BullMQEventBusClient } from '@shipit-ai/event-bus';
import { loadConfig } from '@shipit-ai/shared';
import { CoreWriter } from './writer.js';
import { DEFAULT_CONFIG } from './config.js';
import { Neo4jClient } from './neo4j/client.js';
import { Neo4jNodeWriter } from './neo4j/node-writer.js';
import { Neo4jLinkingKeyIndex } from './neo4j/linking-key-index.js';
import { Neo4jIdempotencyChecker } from './neo4j/idempotency-checker.js';
import { runCanonicalIdMigration, runPersonLoginCaseMigration } from './neo4j/migrations.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const neo4jClient = new Neo4jClient();
  try {
    await neo4jClient.connect({
      uri: config.backend.neo4j.uri,
      username: config.backend.neo4j.user,
      password: config.backend.neo4j.password,
      // Shared config has no database field; NEO4J_DATABASE comes in via
      // DEFAULT_CONFIG (like the other env-tunables below). Newer Aura
      // tiers name the database after the instance ID — without this the
      // client's session default of `neo4j` hits DatabaseNotFound.
      database: DEFAULT_CONFIG.neo4j.database,
    });
    console.log(
      `CoreWriter connected to Neo4j at ${config.backend.neo4j.uri}` +
        ` (db: ${DEFAULT_CONFIG.neo4j.database})`,
    );
  } catch (err) {
    // Fail loudly — if we can't reach Neo4j there's nothing to do.
    console.error(`CoreWriter failed to connect to Neo4j: ${(err as Error).message}`);
    process.exit(1);
  }

  const migrationStats = await runCanonicalIdMigration(neo4jClient);
  const totalAffected =
    Object.values(migrationStats.nodesDeleted).reduce((a, b) => a + b, 0) +
    Object.values(migrationStats.idempotencyEntriesDeleted).reduce((a, b) => a + b, 0);
  if (totalAffected > 0) {
    const labels = Object.keys(migrationStats.nodesDeleted) as Array<
      keyof typeof migrationStats.nodesDeleted
    >;
    const summary = labels
      .map(
        (label) =>
          `${label}: nodes=${migrationStats.nodesDeleted[label]} idempotency=${migrationStats.idempotencyEntriesDeleted[label]}`,
      )
      .join('; ');
    console.log(`CoreWriter canonical-ID migration: ${summary}`);
  }

  // Cleanup for the Person login-case fix: drop orphaned mixed-case Person
  // nodes so the next sync's lowercase Person merges with the login Person.
  const personCaseStats = await runPersonLoginCaseMigration(neo4jClient);
  if (personCaseStats.nodesDeleted > 0 || personCaseStats.idempotencyEntriesDeleted > 0) {
    console.log(
      `CoreWriter Person login-case migration: nodes=${personCaseStats.nodesDeleted} ` +
        `linkingKeys=${personCaseStats.linkingKeysDeleted} ` +
        `idempotency=${personCaseStats.idempotencyEntriesDeleted}`,
    );
  }

  if (!config.backend.redis.url) {
    console.error('CoreWriter requires backend.redis.url to subscribe to events. Exiting.');
    await neo4jClient.close();
    process.exit(1);
  }

  const eventBus = new BullMQEventBusClient({ redisUrl: config.backend.redis.url });

  const nodeWriter = new Neo4jNodeWriter(neo4jClient);
  const linkingKeyIndex = new Neo4jLinkingKeyIndex(neo4jClient);
  const idempotency = new Neo4jIdempotencyChecker(neo4jClient, DEFAULT_CONFIG.idempotencyTtlDays);

  const writer = new CoreWriter(nodeWriter, linkingKeyIndex, idempotency, DEFAULT_CONFIG);
  await writer.start(eventBus);
  console.log(`CoreWriter subscribed to event bus at ${config.backend.redis.url}`);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`CoreWriter received ${signal}, shutting down...`);
    try {
      await writer.stop();
      await eventBus.close();
      await neo4jClient.close();
    } catch (err) {
      console.error(`CoreWriter shutdown error: ${(err as Error).message}`);
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

void main().catch((err) => {
  console.error('CoreWriter crashed during startup:', err);
  process.exit(1);
});
