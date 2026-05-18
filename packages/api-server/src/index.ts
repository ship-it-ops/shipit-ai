import { loadConfig } from './config.js';
import { createServer } from './server.js';
import { Neo4jService } from './services/neo4j-service.js';
import { SchemaService } from './services/schema-service.js';

export { createServer } from './server.js';
export type { CreateServerOptions } from './server.js';
export { ConnectorManager } from './services/connector-manager.js';
export type { ConnectorConfig, SyncStatus } from './services/connector-manager.js';
export { SchemaService } from './services/schema-service.js';
export { Neo4jService } from './services/neo4j-service.js';
export type { GraphStats, NeighborhoodResult } from './services/neo4j-service.js';

async function main() {
  const config = loadConfig();
  const { neo4j, schema, api } = config.backend;

  const neo4jService = new Neo4jService(neo4j.uri, neo4j.user, neo4j.password);
  const schemaService = new SchemaService(schema.path);

  try {
    await schemaService.loadSchema();
  } catch {
    console.warn('Could not load schema from', schema.path, '- starting with no schema');
  }

  const server = await createServer({
    logger: true,
    neo4jService,
    schemaService,
    config,
  });

  try {
    await server.listen({ port: api.port, host: '0.0.0.0' });
    console.log(`ShipIt-AI API server listening on port ${api.port}`);
  } catch (err) {
    server.log.error(err);
    await neo4jService.close();
    process.exit(1);
  }

  const shutdown = async () => {
    await server.close();
    await neo4jService.close();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main();
