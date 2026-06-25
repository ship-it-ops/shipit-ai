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
import { requireCapability } from '../middleware/require-auth.js';
import { actorOf } from './claims.js';
import type { Neo4jService } from '../services/neo4j-service.js';

declare module 'fastify' {
  interface FastifyInstance {
    neo4jService: Neo4jService;
    reconciliationService: ReconciliationService;
  }
}

// Mirror routes/claims.ts: mutating reconciliation routes drive privileged graph
// rewrites (confirmMerge → migrateHumanClaims + repointAuditEvents). They sit
// behind the global requireAuth hook AND a graph:write capability gate, with a
// per-route write rate limit on top of the global limiter (CodeQL's
// js/missing-rate-limiting heuristic flags authorization handlers that lack a
// route-local limiter; these also write the graph and shouldn't be hammerable).
// Read-only routes (the GET list/detail/merges/stats) carry neither.
const WRITE_GATE = { rateLimit: { max: 30, timeWindow: '1 minute' } };
const writeRoute = {
  config: WRITE_GATE,
  preHandler: requireCapability('graph:write'),
};

const reconciliationRoutes: FastifyPluginAsync = async (server) => {
  // Shared instance: the cron scan and the manual /scan endpoint both want the
  // same `lastScanAt` clock.
  if (!server.reconciliationService) {
    server.decorate(
      'reconciliationService',
      new ReconciliationService(
        server.neo4jService,
        server.config.backend.reconciliation.threshold,
      ),
    );
  }
  const service = server.reconciliationService;

  server.get<{
    Querystring: { status?: string; limit?: string };
  }>('/candidates', async (request) => {
    const status =
      (request.query.status as 'pending' | 'confirmed' | 'rejected' | 'distinct') ?? 'pending';
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
  }>('/candidates/:id/confirm', writeRoute, async (request, reply) => {
    try {
      return await service.confirmMerge(request.params.id, actorOf(request));
    } catch (e) {
      return reply.status(400).send({
        error: { code: 'INVALID_STATE', message: (e as Error).message },
      });
    }
  });

  server.post<{
    Params: { id: string };
  }>('/candidates/:id/reject', writeRoute, async (request, reply) => {
    try {
      await service.reject(request.params.id, actorOf(request));
      return { ok: true };
    } catch (e) {
      return reply.status(400).send({
        error: { code: 'INVALID_STATE', message: (e as Error).message },
      });
    }
  });

  server.post<{
    Params: { id: string };
  }>('/candidates/:id/distinct', writeRoute, async (request, reply) => {
    try {
      await service.markDistinct(request.params.id, actorOf(request));
      return { ok: true };
    } catch (e) {
      return reply.status(400).send({
        error: { code: 'INVALID_STATE', message: (e as Error).message },
      });
    }
  });

  server.post('/scan', writeRoute, async () => {
    const created = await service.scan();
    return { created };
  });

  // Used when retuning the scoring heuristics — clears only `pending`
  // candidates so confirmed/rejected user decisions survive.
  server.post('/reset-pending', writeRoute, async () => {
    const removed = await service.resetPending();
    return { removed };
  });

  server.get<{ Querystring: { limit?: string } }>('/merges', async (request) => {
    const limit = request.query.limit ? Math.min(Number(request.query.limit), 500) : 50;
    return service.listMerges(limit);
  });

  server.post<{
    Params: { id: string };
  }>('/merges/:id/split', writeRoute, async (request, reply) => {
    try {
      await service.splitMerge(request.params.id, actorOf(request));
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
