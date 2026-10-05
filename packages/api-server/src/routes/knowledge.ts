// Instance-level facts about the knowledge layer (mounted /api/knowledge).
// Later milestones add containers, documents, search and suggestions here;
// every one of them answers 503 KNOWLEDGE_UNAVAILABLE through `requireKnowledge`
// when a prerequisite is missing.
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type {
  KnowledgeStatus,
  KnowledgeStatusService,
} from '../services/knowledge/knowledge-status-service.js';

declare module 'fastify' {
  interface FastifyInstance {
    knowledgeStatus?: KnowledgeStatusService;
  }
}

export const KNOWLEDGE_NOT_WIRED: KnowledgeStatus = {
  available: false,
  ingestionAvailable: false,
  checks: [
    { name: 'enabled', ok: false, detail: 'The knowledge layer is not set up on this server.' },
  ],
};

/** preHandler for routes that need the layer: 503 with the failing checks. */
export function requireKnowledge(server: { knowledgeStatus?: KnowledgeStatusService }) {
  return async (_request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply | void> => {
    const status = server.knowledgeStatus
      ? await server.knowledgeStatus.status()
      : KNOWLEDGE_NOT_WIRED;
    if (status.ingestionAvailable) return undefined;
    return reply.status(503).send({
      error: {
        code: 'KNOWLEDGE_UNAVAILABLE',
        message: 'The knowledge layer is not available on this server.',
      },
      checks: status.checks.filter((c) => !c.ok),
    });
  };
}

const knowledgeRoutes: FastifyPluginAsync = async (server) => {
  // Any signed-in user: the Connector Hub reads this to enable or explain the knowledge connectors.
  server.get('/status', async () =>
    server.knowledgeStatus ? server.knowledgeStatus.status() : KNOWLEDGE_NOT_WIRED,
  );
};

export default knowledgeRoutes;
