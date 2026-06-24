import type { FastifyPluginAsync } from 'fastify';
import type { Neo4jService } from '../services/neo4j-service.js';

declare module 'fastify' {
  interface FastifyInstance {
    neo4jService: Neo4jService;
  }
}

const graphRoutes: FastifyPluginAsync = async (server) => {
  const neo4j = server.neo4jService;

  // GET /api/graph/stats
  server.get('/stats', async (request) => {
    return neo4j.getGraphStats(request.ctx);
  });

  // GET /api/graph/overview
  server.get<{
    Querystring: { limit?: string; sourceSystem?: string; sourceConnectorId?: string };
  }>('/overview', async (request) => {
    const limit = Math.min(Number(request.query.limit ?? 100), 500);
    return neo4j.getOverview(request.ctx, {
      limit,
      sourceSystem: request.query.sourceSystem,
      sourceConnectorId: request.query.sourceConnectorId,
    });
  });

  // GET /api/graph/sources — distinct (sourceSystem, connectorId) pairs in
  // the graph with entity counts. Populates the catalog/explore source
  // facet so it adapts to whatever connectors actually wrote data.
  server.get('/sources', async () => {
    return neo4j.getSources();
  });

  // GET /api/graph/neighborhood/:id
  server.get<{
    Params: { id: string };
    Querystring: { depth?: string };
  }>('/neighborhood/:id', async (request) => {
    const depth = Math.min(Number(request.query.depth ?? 2), 5);
    return neo4j.getNeighborhood(request.ctx, request.params.id, depth);
  });

  // GET /api/graph/blast-radius/:id
  server.get<{
    Params: { id: string };
    Querystring: { depth?: string };
  }>('/blast-radius/:id', async (request) => {
    const depth = Math.min(Number(request.query.depth ?? 3), 5);
    return neo4j.getBlastRadius(request.ctx, request.params.id, depth);
  });

  // GET /api/graph/search
  server.get<{
    Querystring: {
      label?: string;
      q?: string;
      tier?: string;
      owner?: string;
      sourceSystem?: string;
      sourceConnectorId?: string;
      limit?: string;
    };
  }>('/search', async (request) => {
    const { label, q, tier, owner, sourceSystem, sourceConnectorId, limit } = request.query;
    const filters: Record<string, unknown> = {};
    if (tier) filters.tier = tier;
    if (owner) filters.owner = owner;
    // Underscore-prefixed keys are honored by the searchEntities filter loop
    // (which builds `n.${key} = $filter_${key}` for each entry).
    if (sourceSystem) filters._source_system = sourceSystem;
    if (sourceConnectorId) filters._source_connector_id = sourceConnectorId;

    const records = await neo4j.searchEntities(request.ctx, {
      label,
      q,
      filters,
      limit: limit ? Math.min(Number(limit), 100) : 25,
    });

    // Shape consumed by the global command palette + entity search dropdowns.
    return records.map((record) => {
      const node = record.get('n') as { properties: Record<string, unknown> };
      const labels = (record.get('labels') as string[] | undefined) ?? [];
      const props = node.properties;
      const id = String(props.id ?? '');
      return {
        id,
        canonicalId: id,
        name: String(props.name ?? id.split('/').pop() ?? id),
        label: labels[0] ?? 'Unknown',
        owner: props.owner ? String(props.owner) : undefined,
        lastSynced: props._last_synced ? String(props._last_synced) : undefined,
        sourceSystem: props._source_system ? String(props._source_system) : undefined,
        sourceConnectorId: props._source_connector_id
          ? String(props._source_connector_id)
          : undefined,
        sourceOrg: props._source_org ? String(props._source_org) : undefined,
      };
    });
  });
};

export default graphRoutes;
