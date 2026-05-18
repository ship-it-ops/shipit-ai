// Phase 2: Query Playground.
// Read-only Cypher endpoint backing /explore/query. All requests pass through
// `checkCypherSafety` which strips comments/strings then blocks write keywords
// and dangerous procedures. No auth (out of scope — see Phase 3 RBAC plan).
import type { FastifyPluginAsync } from 'fastify';
import { checkCypherSafety } from '../services/cypher-safety.js';
import { CypherQueryService } from '../services/cypher-query-service.js';
import type { Neo4jService } from '../services/neo4j-service.js';

declare module 'fastify' {
  interface FastifyInstance {
    neo4jService: Neo4jService;
  }
}

const queryRoutes: FastifyPluginAsync = async (server) => {
  const service = new CypherQueryService(
    server.neo4jService.getDriver(),
    server.config.backend.cypherQuery,
  );

  server.post<{
    Body: { cypher?: unknown; params?: unknown };
  }>('/', async (request, reply) => {
    const { cypher, params } = request.body ?? {};

    if (typeof cypher !== 'string') {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: '`cypher` must be a string' },
      });
    }
    if (params !== undefined && (typeof params !== 'object' || params === null)) {
      return reply.status(400).send({
        error: { code: 'VALIDATION_ERROR', message: '`params` must be an object' },
      });
    }

    const safety = checkCypherSafety(cypher);
    if (!safety.safe) {
      return reply.status(400).send({
        error: {
          code: safety.keyword ? 'WRITE_BLOCKED' : 'VALIDATION_ERROR',
          message: safety.reason ?? 'Query rejected by safety check',
          keyword: safety.keyword,
        },
      });
    }

    try {
      const result = await service.execute(cypher, (params as Record<string, unknown>) ?? {});
      return result;
    } catch (err) {
      const message = (err as Error).message;
      const isTimeout = /timeout/i.test(message);
      return reply.status(isTimeout ? 504 : 400).send({
        error: {
          code: isTimeout ? 'QUERY_TIMEOUT' : 'CYPHER_ERROR',
          message,
        },
      });
    }
  });
};

export default queryRoutes;
