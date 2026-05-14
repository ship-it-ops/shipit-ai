import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import { errorHandler } from './middleware/error-handler.js';
import { ConnectorManager } from './services/connector-manager.js';
import { SchemaService } from './services/schema-service.js';
import type { Neo4jService } from './services/neo4j-service.js';
import healthRoutes from './routes/health.js';
import connectorRoutes from './routes/connectors.js';
import schemaRoutes from './routes/schema.js';
import graphRoutes from './routes/graph.js';
import queryRoutes from './routes/query.js';
import claimsRoutes, { conflictsRoutes } from './routes/claims.js';
import teamsRoutes from './routes/teams.js';
import reconciliationRoutes from './routes/reconciliation.js';
import incidentEventsRoutes from './routes/incident-events.js';

export interface CreateServerOptions {
  logger?: boolean;
  schemaService?: SchemaService;
  connectorManager?: ConnectorManager;
  neo4jService?: Neo4jService;
}

export async function createServer(opts: CreateServerOptions = {}): Promise<FastifyInstance> {
  const server = Fastify({
    logger: opts.logger ?? false,
  });

  // Accept plain text bodies for YAML schema endpoints
  server.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });
  server.addContentTypeParser('text/yaml', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });
  server.addContentTypeParser('application/x-yaml', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  await server.register(cors, { origin: true });
  await server.register(swagger, {
    openapi: {
      info: { title: 'ShipIt-AI API', version: '0.1.0' },
    },
  });

  server.setErrorHandler(errorHandler);

  // Decorate with services
  server.decorate('connectorManager', opts.connectorManager ?? new ConnectorManager());
  server.decorate('schemaService', opts.schemaService ?? new SchemaService('./shipit-schema.yaml'));
  if (opts.neo4jService) {
    server.decorate('neo4jService', opts.neo4jService);
  }

  // Register routes
  await server.register(healthRoutes, { prefix: '/api' });
  await server.register(connectorRoutes, { prefix: '/api/connectors' });
  await server.register(schemaRoutes, { prefix: '/api/schema' });

  if (opts.neo4jService) {
    await server.register(graphRoutes, { prefix: '/api/graph' });
    await server.register(queryRoutes, { prefix: '/api/query' });
    await server.register(claimsRoutes, { prefix: '/api/claims' });
    await server.register(conflictsRoutes, { prefix: '/api/conflicts' });
    await server.register(teamsRoutes, { prefix: '/api/teams' });
    await server.register(reconciliationRoutes, { prefix: '/api/reconciliation' });
  }

  // Incident-mode dashboard view log. Doesn't require Neo4j — useful for
  // adoption analytics from day one, even when running the API standalone.
  await server.register(incidentEventsRoutes, { prefix: '/api/incident-events' });

  return server;
}
