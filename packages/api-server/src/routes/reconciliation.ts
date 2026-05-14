// Phase 2: Reconciliation routes.
// GET  /candidates                      list pending fuzzy-match candidates
// GET  /candidates/:id                  side-by-side detail with both nodes
// POST /candidates/:id/confirm          merge the pair, soft-delete the loser
// POST /candidates/:id/reject           dismiss without recording a constraint
// POST /candidates/:id/distinct         mark distinct (writes DISTINCT_FROM)
// POST /scan                            re-run the fuzzy-match scan
// GET  /merges                          recent merges, newest first
// POST /merges/:id/split                reverse a merge
// GET  /stats                           pending/recent/lastScanAt
import type { FastifyPluginAsync } from 'fastify';
import { ReconciliationService } from '../services/reconciliation-service.js';
import type { Neo4jService } from '../services/neo4j-service.js';

declare module 'fastify' {
  interface FastifyInstance {
    neo4jService: Neo4jService;
    reconciliationService: ReconciliationService;
  }
}

const reconciliationRoutes: FastifyPluginAsync = async (server) => {
  // Shared instance: the cron scan and the manual /scan endpoint both want the
  // same `lastScanAt` clock.
  if (!server.reconciliationService) {
    server.decorate('reconciliationService', new ReconciliationService(server.neo4jService));
  }
  const service = server.reconciliationService;

  server.get<{
    Querystring: { status?: string; limit?: string };
  }>('/candidates', async (request) => {
    const status = (request.query.status as 'pending' | 'confirmed' | 'rejected' | 'distinct') ?? 'pending';
    const limit = request.query.limit ? Number(request.query.limit) : undefined;
    return service.listCandidates({ status, limit });
  });

  server.get<{ Params: { id: string } }>('/candidates/:id', async (request, reply) => {
    const detail = await service.getCandidate(request.params.id);
    if (!detail) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: `Candidate ${request.params.id} not found` },
      });
    }
    return detail;
  });

  server.post<{
    Params: { id: string };
    Querystring: { actor?: string };
  }>('/candidates/:id/confirm', async (request, reply) => {
    try {
      return await service.confirmMerge(request.params.id, request.query.actor ?? 'web-ui');
    } catch (e) {
      return reply.status(400).send({
        error: { code: 'INVALID_STATE', message: (e as Error).message },
      });
    }
  });

  server.post<{
    Params: { id: string };
    Querystring: { actor?: string };
  }>('/candidates/:id/reject', async (request, reply) => {
    try {
      await service.reject(request.params.id, request.query.actor ?? 'web-ui');
      return { ok: true };
    } catch (e) {
      return reply.status(400).send({
        error: { code: 'INVALID_STATE', message: (e as Error).message },
      });
    }
  });

  server.post<{
    Params: { id: string };
    Querystring: { actor?: string };
  }>('/candidates/:id/distinct', async (request, reply) => {
    try {
      await service.markDistinct(request.params.id, request.query.actor ?? 'web-ui');
      return { ok: true };
    } catch (e) {
      return reply.status(400).send({
        error: { code: 'INVALID_STATE', message: (e as Error).message },
      });
    }
  });

  server.post('/scan', async () => {
    const created = await service.scan();
    return { created };
  });

  // Used when retuning the scoring heuristics — clears only `pending`
  // candidates so confirmed/rejected user decisions survive.
  server.post('/reset-pending', async () => {
    const removed = await service.resetPending();
    return { removed };
  });

  server.get<{ Querystring: { limit?: string } }>('/merges', async (request) => {
    const limit = request.query.limit ? Math.min(Number(request.query.limit), 500) : 50;
    return service.listMerges(limit);
  });

  server.post<{
    Params: { id: string };
    Querystring: { actor?: string };
  }>('/merges/:id/split', async (request, reply) => {
    try {
      await service.splitMerge(request.params.id, request.query.actor ?? 'web-ui');
      return { ok: true };
    } catch (e) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: (e as Error).message },
      });
    }
  });

  server.get('/stats', async () => service.stats());
};

export default reconciliationRoutes;
