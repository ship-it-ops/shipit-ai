// packages/api-server/src/routes/connector-containers.ts
// The containers of a knowledge connector (mounted /api/connectors, beside the
// connector routes): what the source has, what an admin selected, and what is
// stored for each. Spec §API. Reading is open to every signed-in user;
// refreshing and selecting are an administrator's.
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import type { ContainerSummary, KnowledgeStore } from '@shipit-ai/knowledge';
import { requireAdmin } from '../middleware/require-auth.js';
import {
  KnowledgeRefreshError,
  type KnowledgeSyncScheduler,
} from '../services/knowledge-sync-scheduler.js';
import { requireKnowledge } from './knowledge.js';

declare module 'fastify' {
  interface FastifyInstance {
    knowledgeStore?: Pick<
      KnowledgeStore,
      'containersWithCounts' | 'getContainer' | 'selectContainer'
    >;
    knowledgeScheduler?: Pick<KnowledgeSyncScheduler, 'refreshContainers'>;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What the picker shows. The checkpoint and the ACL snapshot stay server-side. */
function present(c: ContainerSummary) {
  return {
    id: c.id,
    externalId: c.externalId,
    kind: c.kind,
    name: c.name,
    url: c.url,
    visibility: c.visibility,
    archived: c.archived,
    selected: c.selected,
    visibilityAcknowledged: c.visibilityAcknowledgedBy !== null,
    purging: c.purgeRequestedAt !== null,
    lastPolledAt: c.lastPolledAt,
    lastReconciledAt: c.lastReconciledAt,
    documents: c.documents,
    indexed: c.indexed,
    pending: c.pending,
    failed: c.failed,
    restricted: c.restricted,
  };
}

const notFound = (reply: FastifyReply, message: string): FastifyReply =>
  reply.status(404).send({ error: { code: 'NOT_FOUND', message } });

const notWired = (reply: FastifyReply): FastifyReply =>
  reply.status(503).send({
    error: {
      code: 'KNOWLEDGE_UNAVAILABLE',
      message: 'The knowledge layer is not available on this server.',
    },
  });

const connectorContainerRoutes: FastifyPluginAsync = async (server) => {
  const available = requireKnowledge(server);
  const connectorExists = (id: string): boolean => {
    try {
      server.connectorRegistry.get(id);
      return true;
    } catch {
      return false;
    }
  };

  server.get<{ Params: { id: string }; Querystring: { q?: string } }>(
    '/:id/containers',
    { preHandler: available },
    async (request, reply) => {
      if (!connectorExists(request.params.id)) return notFound(reply, 'No such connector.');
      if (!server.knowledgeStore) return notWired(reply);
      const rows = await server.knowledgeStore.containersWithCounts(
        request.params.id,
        typeof request.query.q === 'string' ? request.query.q.slice(0, 200) : undefined,
      );
      return { containers: rows.map(present) };
    },
  );

  server.post<{ Params: { id: string } }>(
    '/:id/containers/refresh',
    { preHandler: [requireAdmin, available] },
    async (request, reply) => {
      if (!connectorExists(request.params.id)) return notFound(reply, 'No such connector.');
      if (!server.knowledgeScheduler) return notWired(reply);
      try {
        return { containers: await server.knowledgeScheduler.refreshContainers(request.params.id) };
      } catch (err) {
        if (!(err instanceof KnowledgeRefreshError)) throw err;
        const status =
          err.code === 'KNOWLEDGE_NOT_ENABLED' ? 409 : err.code === 'AUTH_FAILED' ? 502 : 400;
        return reply.status(status).send({ error: { code: err.code, message: err.message } });
      }
    },
  );

  server.put<{
    Params: { id: string; containerId: string };
    Body: { selected?: unknown; acknowledgeVisibility?: unknown };
  }>(
    '/:id/containers/:containerId',
    { preHandler: [requireAdmin, available] },
    async (request, reply) => {
      const { id, containerId } = request.params;
      if (!connectorExists(id)) return notFound(reply, 'No such connector.');
      if (!server.knowledgeStore) return notWired(reply);
      const selected = request.body?.selected;
      if (typeof selected !== 'boolean') {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: '`selected` must be true or false.' },
        });
      }
      const container = UUID.test(containerId)
        ? await server.knowledgeStore.getContainer(id, containerId)
        : null;
      if (!container) return notFound(reply, 'No such container.');
      const acknowledged = request.body?.acknowledgeVisibility === true;
      // Everything indexed is visible to every signed-in user (spec
      // §Visibility), so content the source restricts needs an explicit yes.
      if (selected && container.visibility !== 'open' && !acknowledged) {
        return reply.status(409).send({
          error: {
            code: 'VISIBILITY_NOT_ACKNOWLEDGED',
            message:
              'This container is not open to everyone at the source. Indexing it makes its content visible to every signed-in user; send acknowledgeVisibility: true to accept that.',
          },
        });
      }
      await server.knowledgeStore.selectContainer(id, containerId, {
        selected,
        by: request.ctx.user.email ?? request.ctx.user.id,
        acknowledged,
      });
      return { ok: true };
    },
  );
};

export default connectorContainerRoutes;
