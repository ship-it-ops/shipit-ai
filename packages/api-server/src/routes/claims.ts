// Phase 2: Claim Explorer routes.
// GET  /api/claims/:entityId                       -> all property claims + resolved winner
// POST /api/claims/:entityId/:propertyKey/verify   -> user-verify a field value
// GET  /api/claims/review-queue                    -> verified fields contradicted by re-sync
// POST /api/claims/review/resolve                  -> accept/reject a queued re-review
// GET  /api/conflicts                              -> entities with active property conflicts
// Write paths capture the acting user (Phase 3 RBAC will gate them).
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { ClaimService } from '../services/claim-service.js';
import { VerificationService } from '../services/verification-service.js';
import {
  type ManualEditService,
  ManualEditValidationError,
  ManualEditNotFoundError,
} from '../services/manual-edit-service.js';
import { requireCapability } from '../middleware/require-auth.js';
import type { Neo4jService } from '../services/neo4j-service.js';
import type { SchemaService } from '../services/schema-service.js';

declare module 'fastify' {
  interface FastifyInstance {
    neo4jService: Neo4jService;
    schemaService: SchemaService;
    // Manual-edit write path (claims v1a). Decorated in server.ts only when a
    // neo4jService is wired (same gate the claims routes register behind).
    manualEditService?: ManualEditService;
  }
}

// Audit actor = the authenticated principal, never a client-supplied value.
// `request.ctx` is populated by require-auth for every request (the resolution
// ladder there falls back to a synthesized dev/system principal when auth is
// disabled), so `ctx.user.email` is always the real acting identity. Trusting a
// `?actor=` query param here would let any caller forge VerificationEvent.actor.
export function actorOf(request: { ctx: { user: { email: string } } }): string {
  return request.ctx.user.email;
}

// Per-route rate limits on top of the global limiter (server.ts). CodeQL's
// js/missing-rate-limiting heuristic flags authorization handlers that lack a
// route-local limiter; these also write/read the graph and shouldn't be
// hammerable. Mutating routes get a tighter bound than reads.
const WRITE_RATE_LIMIT = { rateLimit: { max: 30, timeWindow: '1 minute' } };
const READ_RATE_LIMIT = { rateLimit: { max: 120, timeWindow: '1 minute' } };

// Manual-write routes are keyed per-PRINCIPAL, not per-IP: many humans behind
// one office NAT/VPN share an egress IP, so IP-keying would let one user starve
// the whole office's edit budget. The keyGenerator resolves the stable
// principal id (`token:<id>` for MCP tokens, the IdP subject for humans,
// `anonymous` for the unauthenticated — though those are 403'd by
// requireCapability before they ever reach a write). Humans get a generous
// budget; token principals get a tighter one (automation shouldn't author
// manual claims at human speed, and a leaked token is blast-radius-bounded).
const MANUAL_WRITE_HUMAN_MAX = 60;
const MANUAL_WRITE_TOKEN_MAX = 20;

export function manualWriteRateKey(request: FastifyRequest): string {
  const id = request.ctx.user.id;
  // `anonymous` and empty ids fall back to IP so a misconfigured open
  // deployment still can't be hammered limitlessly on this route.
  if (!id || id === 'anonymous') return request.ip;
  return id;
}

const MANUAL_WRITE_RATE_LIMIT = {
  rateLimit: {
    max: (request: FastifyRequest) =>
      request.ctx.user.provider === 'mcp-token' ? MANUAL_WRITE_TOKEN_MAX : MANUAL_WRITE_HUMAN_MAX,
    timeWindow: '1 minute',
    keyGenerator: manualWriteRateKey,
  },
};

// Map a ManualEditService error to its HTTP response per the T2 contract:
//   ManualEditValidationError (INVALID_VALUE_TYPE) → 400
//   ManualEditNotFoundError   (ENTITY_NOT_FOUND)   → 404
// NO_MANUAL_CLAIM (idempotent 204) is handled at the call site before this.
// Anything else is unexpected → rethrow to the global error handler (500).
function replyForManualEditError(reply: FastifyReply, e: unknown): FastifyReply {
  if (e instanceof ManualEditValidationError) {
    return reply.status(400).send({ error: { code: e.code, message: e.message } });
  }
  if (e instanceof ManualEditNotFoundError && e.code === 'ENTITY_NOT_FOUND') {
    return reply.status(404).send({ error: { code: e.code, message: e.message } });
  }
  throw e;
}

const claimsRoutes: FastifyPluginAsync = async (server) => {
  const service = new ClaimService(server.neo4jService, server.schemaService);
  const verification = new VerificationService(server.neo4jService);

  // Kill-switch preHandler for the manual-write routes. Default ON; flip
  // accessControl.manualWrite.enabled to false for an instant rollback that
  // 403s writes (FEATURE_DISABLED) while leaving read paths untouched.
  const requireManualWriteEnabled = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | void> => {
    if (request.server.config?.accessControl.manualWrite.enabled === false) {
      return reply.status(403).send({
        error: {
          code: 'FEATURE_DISABLED',
          message: 'Manual editing is disabled on this deployment.',
        },
      });
    }
    return undefined;
  };

  // Both manual routes share the same gate ladder: requireAuth (global
  // preHandler) → graph:write capability → kill-switch. The service is
  // decorated only when Neo4j is wired (same gate this plugin registers
  // behind), so the 503 guard is defensive.
  const manualWriteGate = [requireCapability('graph:write'), requireManualWriteEnabled];

  const requireManualEditService = (reply: FastifyReply): ManualEditService | null => {
    if (!server.manualEditService) {
      reply.status(503).send({
        error: {
          code: 'MANUAL_EDIT_DISABLED',
          message: 'Manual editing is not wired on this deployment.',
        },
      });
      return null;
    }
    return server.manualEditService;
  };

  // Static routes registered before the `/:entityId` param route so they win.
  server.get<{ Querystring: { limit?: string } }>(
    '/review-queue',
    { config: READ_RATE_LIMIT },
    async (request) => {
      const limit = request.query.limit ? Math.min(Number(request.query.limit), 500) : 100;
      return verification.listReviewQueue(limit);
    },
  );

  server.post<{
    Body: { entityId: string; propertyKey: string; action: 'accept' | 'reject' };
  }>('/review/resolve', { config: WRITE_RATE_LIMIT }, async (request, reply) => {
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
  }>('/:entityId/:propertyKey/verify', { config: WRITE_RATE_LIMIT }, async (request, reply) => {
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

  // Manual-edit write path (claims v1a). Author/replace a `manual:<actor>`
  // claim that overrides the resolved value and survives connector re-syncs.
  // Gated: requireAuth → graph:write → kill-switch; principal-keyed rate limit.
  server.post<{
    Params: { entityId: string; propertyKey: string };
    Body: { value: unknown; evidence?: string | null };
  }>(
    '/:entityId/:propertyKey/manual',
    { config: MANUAL_WRITE_RATE_LIMIT, preHandler: manualWriteGate },
    async (request, reply) => {
      const svc = requireManualEditService(reply);
      if (!svc) return reply;
      const entityId = decodeURIComponent(request.params.entityId);
      const propertyKey = decodeURIComponent(request.params.propertyKey);
      try {
        return await svc.setManualClaim({
          entityId,
          propertyKey,
          value: request.body?.value,
          evidence: request.body?.evidence ?? null,
          actor: actorOf(request),
        });
      } catch (e) {
        return replyForManualEditError(reply, e);
      }
    },
  );

  // Remove the caller's own `manual:<actor>` claim (admins may target another
  // actor via ?actor=). Falls back to the next-ranked claim. Idempotent:
  // nothing to remove → 204.
  server.delete<{
    Params: { entityId: string; propertyKey: string };
    Querystring: { actor?: string };
  }>(
    '/:entityId/:propertyKey/manual',
    { config: MANUAL_WRITE_RATE_LIMIT, preHandler: manualWriteGate },
    async (request, reply) => {
      const svc = requireManualEditService(reply);
      if (!svc) return reply;
      const entityId = decodeURIComponent(request.params.entityId);
      const propertyKey = decodeURIComponent(request.params.propertyKey);

      // `?actor=` lets an admin revert another user's manual claim. A
      // non-admin supplying it is an authorization escalation attempt → 403,
      // never silently honored. Absent/empty param = revert the caller's own.
      const requestedActor = request.query.actor?.trim();
      let targetActor: string | undefined;
      if (requestedActor) {
        if (request.ctx.user.role !== 'admin') {
          return reply.status(403).send({
            error: {
              code: 'FORBIDDEN',
              message: 'Only admins may revert another user’s manual claim.',
            },
          });
        }
        targetActor = requestedActor;
      }

      try {
        return await svc.revertManualClaim({
          entityId,
          propertyKey,
          actor: actorOf(request),
          targetActor,
        });
      } catch (e) {
        if (e instanceof ManualEditNotFoundError && e.code === 'NO_MANUAL_CLAIM') {
          // Idempotent: nothing to remove. No body on 204.
          return reply.status(204).send();
        }
        return replyForManualEditError(reply, e);
      }
    },
  );

  server.get<{ Params: { entityId: string } }>(
    '/:entityId',
    { config: READ_RATE_LIMIT },
    async (request, reply) => {
      const entityId = decodeURIComponent(request.params.entityId);
      const result = await service.getClaimsForEntity(entityId);
      if (!result) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: `Entity ${entityId} not found` },
        });
      }
      return result;
    },
  );
};

export const conflictsRoutes: FastifyPluginAsync = async (server) => {
  const service = new ClaimService(server.neo4jService, server.schemaService);

  server.get<{
    Querystring: { label?: string; tier?: string; limit?: string };
  }>('/', { config: READ_RATE_LIMIT }, async (request) => {
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
