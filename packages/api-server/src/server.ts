import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import type { Config } from '@shipit-ai/shared';
import { errorHandler } from './middleware/error-handler.js';
import { ConnectorRegistry } from './services/connector-registry.js';
import { SchemaService } from './services/schema-service.js';
import { GitHubAppService } from './services/github-app-service.js';
import { GitHubAppManifestService } from './services/github-app-manifest-service.js';
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
import mcpRoutes from './routes/mcp.js';

export interface CreateServerOptions {
  logger?: boolean;
  schemaService?: SchemaService;
  connectorRegistry?: ConnectorRegistry;
  githubAppService?: GitHubAppService;
  githubAppManifestService?: GitHubAppManifestService;
  neo4jService?: Neo4jService;
  config?: Config;
  // Path to shipit.config.local.yaml. Used when no registry is supplied so
  // the server can construct one bound to the right file. Tests can omit
  // this and rely on the injected registry instead.
  localConfigPath?: string;
}

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
  }
}

export async function createServer(opts: CreateServerOptions = {}): Promise<FastifyInstance> {
  const server = Fastify({
    logger: opts.logger ?? false,
  });

  if (opts.config) {
    server.decorate('config', opts.config);
  }

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
  // Global rate limit. Conservative defaults (200 req/min per IP) protect
  // the expensive endpoints (probe, manifest exchange, installations
  // listing — they hit the filesystem, the GitHub API, or both) from
  // accidental loops and abusive scans. CodeQL js/missing-rate-limiting
  // requires *some* limiter on routes that do FS access + authorization.
  // Routes can override via { config: { rateLimit: {...} } } when they
  // need tighter or looser bounds.
  await server.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    // Skip during tests so the suite isn't tracking per-IP counters
    // across hundreds of injected requests.
    enableDraftSpec: true,
  });
  await server.register(swagger, {
    openapi: {
      info: { title: 'ShipIt-AI API', version: '0.1.0' },
    },
  });

  server.setErrorHandler(errorHandler);

  // Decorate with services. The registry needs a localConfigPath to write
  // back to; if neither a registry nor a path is provided (e.g. unit tests
  // that don't touch persistence), fall back to a throwaway path inside
  // /tmp so a stray write doesn't clobber the real local file.
  const registry =
    opts.connectorRegistry ??
    new ConnectorRegistry({
      localConfigPath:
        opts.localConfigPath ?? `/tmp/shipit-connectors-${process.pid}-${Date.now()}.yaml`,
      initial: opts.config?.connectors.instances ?? [],
    });
  server.decorate('connectorRegistry', registry);
  server.decorate('schemaService', opts.schemaService ?? new SchemaService('./shipit-schema.yaml'));
  // GitHubAppService is optional — tests that don't touch the global App
  // routes can skip it, and the routes return 503 if it's not decorated.
  if (opts.githubAppService) {
    server.decorate('githubAppService', opts.githubAppService);
  }
  // Manifest service is also optional. Requires githubAppService to be
  // present (it persists via that service), so callers must wire both
  // together — see api-server/src/index.ts for the production bootstrap.
  if (opts.githubAppManifestService) {
    server.decorate('githubAppManifestService', opts.githubAppManifestService);
  }
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

  // MCP server metadata (auth status, tool catalog). Surface for the in-app
  // /configure/mcp page; also useful for future CLI/plugin discovery.
  await server.register(mcpRoutes, { prefix: '/api/mcp' });

  return server;
}
