import type { FastifyPluginAsync } from 'fastify';

interface IncidentViewEvent {
  timestamp: string;
  serviceId: string;
  requestId: string;
  referer: string | null;
}

/**
 * In-memory ring buffer for adoption analytics. The Phase 2 adoption
 * dashboard reads this; production deployments should pipe Fastify's
 * structured logs (`event: 'incident_view'`) into their aggregator instead.
 */
const RING_BUFFER_SIZE = 1000;
const events: IncidentViewEvent[] = [];

const incidentEventsRoutes: FastifyPluginAsync = async (server) => {
  // POST /api/incident-events/view — records a single dashboard view.
  // Bodyless, idempotent per request. Service id is in the body so we can
  // accept both authenticated and unauthenticated calls during Phase 1.
  server.post<{
    Body: { serviceId: string };
  }>('/view', async (request, reply) => {
    const { serviceId } = request.body ?? { serviceId: '' };
    if (typeof serviceId !== 'string' || serviceId.length === 0) {
      return reply.code(400).send({ error: 'serviceId is required' });
    }

    const event: IncidentViewEvent = {
      timestamp: new Date().toISOString(),
      serviceId,
      requestId: request.id,
      referer: request.headers.referer ?? null,
    };

    // Push to ring buffer; drop oldest when full.
    events.push(event);
    if (events.length > RING_BUFFER_SIZE) events.shift();

    // Structured log line for production aggregators.
    request.log.info(
      { event: 'incident_view', serviceId, referer: event.referer },
      'incident_view',
    );

    return reply.code(204).send();
  });

  // GET /api/incident-events/recent — adoption dashboard data source (Phase 2).
  // Returns the in-memory buffer. Limit defaults to 100; max 1000.
  server.get<{
    Querystring: { limit?: string; serviceId?: string };
  }>('/recent', async (request) => {
    const limit = Math.min(Number(request.query.limit ?? 100), RING_BUFFER_SIZE);
    const filter = request.query.serviceId;
    const filtered = filter ? events.filter((e) => e.serviceId === filter) : events;
    // Most recent first.
    return filtered.slice(-limit).reverse();
  });
};

export default incidentEventsRoutes;
