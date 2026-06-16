// Phase 2: Claim Explorer routes.
// GET  /api/claims/:entityId                       -> all property claims + resolved winner
// POST /api/claims/:entityId/:propertyKey/verify   -> user-verify a field value
// GET  /api/claims/review-queue                    -> verified fields contradicted by re-sync
// POST /api/claims/review/resolve                  -> accept/reject a queued re-review
// GET  /api/conflicts                              -> entities with active property conflicts
// Write paths capture the acting user (Phase 3 RBAC will gate them).
import type { FastifyPluginAsync } from 'fastify';
import { ClaimService } from '../services/claim-service.js';
import { VerificationService } from '../services/verification-service.js';
import type { Neo4jService } from '../services/neo4j-service.js';
import type { SchemaService } from '../services/schema-service.js';

declare module 'fastify' {
  interface FastifyInstance {
    neo4jService: Neo4jService;
    schemaService: SchemaService;
  }
}

function actorOf(request: {
  session?: { principal?: { email?: string } };
  query: unknown;
}): string {
  const sessionEmail = request.session?.principal?.email;
  if (sessionEmail) return sessionEmail;
  const q = request.query as { actor?: string } | undefined;
  return q?.actor ?? 'web-ui';
}

const claimsRoutes: FastifyPluginAsync = async (server) => {
  const service = new ClaimService(server.neo4jService, server.schemaService);
  const verification = new VerificationService(server.neo4jService);

  // Static routes registered before the `/:entityId` param route so they win.
  server.get<{ Querystring: { limit?: string } }>('/review-queue', async (request) => {
    const limit = request.query.limit ? Math.min(Number(request.query.limit), 500) : 100;
    return verification.listReviewQueue(limit);
  });

  server.post<{
    Body: { entityId: string; propertyKey: string; action: 'accept' | 'reject' };
    Querystring: { actor?: string };
  }>('/review/resolve', async (request, reply) => {
    const { entityId, propertyKey, action } = request.body;
    if (action !== 'accept' && action !== 'reject') {
      return reply.status(400).send({
        error: { code: 'INVALID_ACTION', message: 'action must be accept or reject' },
      });
    }
    try {
      return await verification.resolveReview(entityId, propertyKey, action, actorOf(request));
    } catch (e) {
      return reply.status(400).send({
        error: { code: 'INVALID_STATE', message: (e as Error).message },
      });
    }
  });

  server.post<{
    Params: { entityId: string; propertyKey: string };
    Body: { value: unknown; evidence?: string | null };
    Querystring: { actor?: string };
  }>('/:entityId/:propertyKey/verify', async (request, reply) => {
    const entityId = decodeURIComponent(request.params.entityId);
    const propertyKey = decodeURIComponent(request.params.propertyKey);
    try {
      return await verification.verify(
        entityId,
        propertyKey,
        request.body?.value,
        actorOf(request),
        request.body?.evidence ?? null,
      );
    } catch (e) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: (e as Error).message },
      });
    }
  });

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
