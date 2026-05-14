// Phase 2: Claim Explorer routes.
// GET /api/claims/:entityId      -> all property claims + resolved winner
// GET /api/conflicts             -> entities with active property conflicts
// No auth (Phase 3 RBAC will gate write-only override paths).
import type { FastifyPluginAsync } from 'fastify';
import { ClaimService } from '../services/claim-service.js';
import type { Neo4jService } from '../services/neo4j-service.js';
import type { SchemaService } from '../services/schema-service.js';

declare module 'fastify' {
  interface FastifyInstance {
    neo4jService: Neo4jService;
    schemaService: SchemaService;
  }
}

const claimsRoutes: FastifyPluginAsync = async (server) => {
  const service = new ClaimService(server.neo4jService, server.schemaService);

  server.get<{ Params: { entityId: string } }>('/:entityId', async (request, reply) => {
    const entityId = decodeURIComponent(request.params.entityId);
    const result = await service.getClaimsForEntity(entityId);
    if (!result) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: `Entity ${entityId} not found` },
      });
    }
    return result;
  });
};

export const conflictsRoutes: FastifyPluginAsync = async (server) => {
  const service = new ClaimService(server.neo4jService, server.schemaService);

  server.get<{
    Querystring: { label?: string; tier?: string; limit?: string };
  }>('/', async (request) => {
    const { label, tier, limit } = request.query;
    const tierNum = tier ? Number(tier) : undefined;
    return service.listConflicts({
      label,
      tier: Number.isFinite(tierNum) ? tierNum : undefined,
      limit: limit ? Math.min(Number(limit), 500) : 100,
    });
  });
};

export default claimsRoutes;
