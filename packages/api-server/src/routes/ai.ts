// Instance-level facts about agent features (mounted /api/ai): whether they
// are available and which models an agent may use.
import type { FastifyPluginAsync } from 'fastify';
import { requireCapability } from '../middleware/require-auth.js';
import type { AiStatus, AiStatusService } from '../services/ai/ai-status-service.js';

declare module 'fastify' {
  interface FastifyInstance {
    aiStatus?: AiStatusService;
  }
}

// What a server built without the status service reports (unit servers, and
// any deployment that predates agents).
export const AI_NOT_WIRED: AiStatus = {
  available: false,
  definitionsAvailable: false,
  checks: [{ name: 'enabled', ok: false, detail: 'Agent features are not set up on this server.' }],
};

const aiRoutes: FastifyPluginAsync = async (server) => {
  // Any signed-in user: the AI pages read this to show setup guidance.
  server.get('/status', async () => (server.aiStatus ? server.aiStatus.status() : AI_NOT_WIRED));

  server.get('/models', { preHandler: requireCapability('agents:read') }, async () => {
    const ai = server.config?.ai;
    return {
      defaultModel: ai?.defaultModel ?? '',
      // modelId (the provider's own id) stays server-side; agents store the key.
      models: (ai?.models ?? []).map(({ key, label, family, contextWindow, tools }) => ({
        key,
        label,
        family,
        contextWindow,
        tools,
      })),
    };
  });
};

export default aiRoutes;
