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
      'containersWithCounts' | 'getContainer' | 'selectContainer' | 'deselectConnector'
    >;
    knowledgeScheduler?: Pick<
      KnowledgeSyncScheduler,
      'refreshContainers' | 'refreshContainer' | 'retire' | 'unretire'
    >;
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
    // The source no longer lists it; it is shown while it is selected or
    // still holds content, so that it can be deselected.
    gone: c.goneAt !== null,
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

/** The status a refused container refresh answers with. */
const refreshStatus = (err: KnowledgeRefreshError): number => {
  if (err.code === 'KNOWLEDGE_NOT_ENABLED' || err.code === 'CONNECTOR_BEING_DELETED') return 409;
  if (err.code === 'AUTH_FAILED') return 502;
  // The source asked to wait longer than a request should: try again later.
  if (err.code === 'RATE_LIMITED') return 429;
  if (err.code === 'SOURCE_TIMEOUT') return 504;
  if (err.code === 'KNOWLEDGE_UNAVAILABLE') return 503;
  return 400;
};

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
        return reply
          .status(refreshStatus(err))
          .send({ error: { code: err.code, message: err.message } });
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
      const store = server.knowledgeStore;
      if (!store) return notWired(reply);
      const selected = request.body?.selected;
      if (typeof selected !== 'boolean') {
        return reply.status(400).send({
          error: { code: 'VALIDATION_ERROR', message: '`selected` must be true or false.' },
        });
      }
      const find = async () =>
        UUID.test(containerId) ? store.getContainer(id, containerId) : null;
      let container = await find();
      if (!container) return notFound(reply, 'No such container.');
      const acknowledged = request.body?.acknowledgeVisibility === true;
      // Everything indexed is visible to every signed-in user (spec
      // §Visibility), so content the source restricts needs an explicit yes.
      const refuse = (): FastifyReply =>
        reply.status(409).send({
          error: {
            code: 'VISIBILITY_NOT_ACKNOWLEDGED',
            message:
              'This container is not open to everyone at the source. Indexing it makes its content visible to every signed-in user; send acknowledgeVisibility: true to accept that.',
          },
        });
      const gone = (): FastifyReply =>
        reply.status(409).send({
          error: {
            code: 'CONTAINER_GONE',
            message:
              'The source no longer has this container, so it cannot be selected. Deselect it to remove what it holds, or refresh the list.',
          },
        });
      if (selected) {
        // Not at the source any more, or on its way out with a deleted
        // connector: there is nothing to index, and selecting it would keep
        // what an earlier selection left.
        if (container.goneAt !== null) return gone();
        // "Open" is what the last listing said, up to a day ago. Before content
        // is indexed on that word, ask the source now, about this one
        // container. Also when the request carries an acknowledgement: it is
        // recorded against what the source says today, not against the stale row.
        if (container.visibility === 'open') {
          if (!server.knowledgeScheduler) return notWired(reply);
          try {
            if (!(await server.knowledgeScheduler.refreshContainer(id, container))) return gone();
          } catch (err) {
            if (!(err instanceof KnowledgeRefreshError)) throw err;
            return reply
              .status(refreshStatus(err))
              .send({ error: { code: err.code, message: err.message } });
          }
          container = await find();
          if (!container) return notFound(reply, 'No such container.');
          if (container.goneAt !== null) return gone();
        }
        if (container.visibility !== 'open' && !acknowledged) return refuse();
      }
      await store.selectContainer(id, containerId, {
        selected,
        by: request.ctx.user.email ?? request.ctx.user.id,
        acknowledged,
      });
      return { ok: true };
    },
  );
};

export default connectorContainerRoutes;
