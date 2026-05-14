import neo4j, { type Driver, type Record as Neo4jRecord } from 'neo4j-driver';

export interface GraphStats {
  nodeCount: number;
  edgeCount: number;
  nodesByLabel: Record<string, number>;
  edgeCountsByType: Record<string, number>;
  staleness: number;
  lastSync: string;
  healthScore: number;
}

export interface CytoscapeNode {
  data: { id: string; label: string; [key: string]: unknown };
}

export interface CytoscapeEdge {
  data: { source: string; target: string; type: string; [key: string]: unknown };
}

export interface NeighborhoodResult {
  nodes: CytoscapeNode[];
  edges: CytoscapeEdge[];
}

export class Neo4jService {
  private driver: Driver;

  constructor(uri: string, user: string, password: string) {
    this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
  }

  /** Used by services that need their own session config (read-only, txn timeout, etc). */
  getDriver(): Driver {
    return this.driver;
  }

  async runQuery(cypher: string, params: Record<string, unknown> = {}): Promise<Neo4jRecord[]> {
    const session = this.driver.session();
    try {
      const result = await session.run(cypher, params);
      return result.records;
    } finally {
      await session.close();
    }
  }

  async getGraphStats(): Promise<GraphStats> {
    const nodeCountsResult = await this.runQuery(
      'CALL db.labels() YIELD label RETURN label, COUNT { MATCH (n) WHERE label IN labels(n) } AS count',
    );
    const edgeCountsResult = await this.runQuery(
      'CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType, COUNT { MATCH ()-[r]->() WHERE type(r) = relationshipType } AS count',
    );

    const nodesByLabel: Record<string, number> = {};
    let nodeCount = 0;
    for (const record of nodeCountsResult) {
      const label = record.get('label') as string;
      const count = record.get('count') as { toNumber?: () => number };
      const num = typeof count === 'object' && count?.toNumber ? count.toNumber() : Number(count);
      nodesByLabel[label] = num;
      nodeCount += num;
    }

    const edgeCountsByType: Record<string, number> = {};
    let edgeCount = 0;
    for (const record of edgeCountsResult) {
      const relType = record.get('relationshipType') as string;
      const count = record.get('count') as { toNumber?: () => number };
      const num = typeof count === 'object' && count?.toNumber ? count.toNumber() : Number(count);
      edgeCountsByType[relType] = num;
      edgeCount += num;
    }

    return {
      nodeCount,
      edgeCount,
      nodesByLabel,
      edgeCountsByType,
      staleness: 0,
      lastSync: new Date().toISOString(),
      healthScore: 100,
    };
  }

  async getNeighborhood(nodeId: string, depth: number = 2): Promise<NeighborhoodResult> {
    // Project edge endpoints by the canonical `id` property — `rel.start` /
    // `rel.end` would be Neo4j's internal numeric node ids, which the UI can't
    // line up with the `shipit://…` ids on the node payload.
    const records = await this.runQuery(
      `MATCH (start {id: $nodeId})
       CALL apoc.path.subgraphAll(start, {maxLevel: $depth})
       YIELD nodes, relationships
       RETURN nodes,
              [rel IN relationships | {
                source: startNode(rel).id,
                target: endNode(rel).id,
                type: type(rel),
                props: properties(rel)
              }] AS rels`,
      { nodeId, depth: neo4j.int(depth) },
    );

    const nodesMap = new Map<string, CytoscapeNode>();
    const edges: CytoscapeEdge[] = [];

    for (const record of records) {
      const nodes = record.get('nodes') as Array<{
        properties: Record<string, unknown>;
        labels: string[];
      }>;
      const rels = record.get('rels') as Array<{
        source: string;
        target: string;
        type: string;
        props: Record<string, unknown>;
      }>;

      for (const node of nodes) {
        const id = String(node.properties.id ?? node.properties.name ?? '');
        const nodeLabel = node.labels[0] ?? 'Unknown';
        if (!nodesMap.has(id)) {
          nodesMap.set(id, {
            data: {
              ...node.properties,
              id,
              label: nodeLabel,
              type: nodeLabel,
              name: String(
                node.properties.name ?? node.properties.login ?? id.split('/').pop() ?? id,
              ),
            },
          });
        }
      }

      for (const rel of rels) {
        edges.push({
          data: {
            ...rel.props,
            source: String(rel.source),
            target: String(rel.target),
            type: rel.type,
          },
        });
      }
    }

    return { nodes: Array.from(nodesMap.values()), edges };
  }

  async getOverview(limit: number = 100): Promise<NeighborhoodResult> {
    const nodeRecords = await this.runQuery(
      'MATCH (n) RETURN n, labels(n) AS labels LIMIT $limit',
      { limit: neo4j.int(limit) },
    );

    const nodesMap = new Map<string, CytoscapeNode>();
    for (const record of nodeRecords) {
      const node = record.get('n') as { properties: Record<string, unknown> };
      const labels = record.get('labels') as string[];
      const id = String(node.properties.id ?? node.properties.name ?? '');
      const nodeLabel = labels[0] ?? 'Unknown';
      if (!nodesMap.has(id)) {
        nodesMap.set(id, {
          data: {
            ...node.properties,
            id,
            label: nodeLabel,
            type: nodeLabel,
            name: String(
              node.properties.name ?? node.properties.login ?? id.split('/').pop() ?? id,
            ),
          },
        });
      }
    }

    const nodeIds = Array.from(nodesMap.keys());

    // Only fetch edges where *both* endpoints landed in the limited node set —
    // Cytoscape throws if an edge references a missing node. Without the id
    // filter, two independent `LIMIT`s would slice nodes and edges out of sync.
    const edgeRecords =
      nodeIds.length === 0
        ? []
        : await this.runQuery(
            `MATCH (a)-[r]->(b)
             WHERE a.id IN $ids AND b.id IN $ids
             RETURN a.id AS source, b.id AS target, type(r) AS type, properties(r) AS props`,
            { ids: nodeIds },
          );

    const edges: CytoscapeEdge[] = edgeRecords.map((record) => ({
      data: {
        ...(record.get('props') as Record<string, unknown>),
        source: String(record.get('source')),
        target: String(record.get('target')),
        type: String(record.get('type')),
      },
    }));

    return { nodes: Array.from(nodesMap.values()), edges };
  }

  async searchEntities(opts: {
    label?: string;
    filters?: Record<string, unknown>;
    limit?: number;
    sortBy?: string;
  }): Promise<Neo4jRecord[]> {
    const { label, filters = {}, limit = 25, sortBy } = opts;
    const nodeLabel = label ? `:${label}` : '';
    const whereClause: string[] = [];
    const params: Record<string, unknown> = { limit: neo4j.int(limit) };

    for (const [key, value] of Object.entries(filters)) {
      whereClause.push(`n.${key} = $filter_${key}`);
      params[`filter_${key}`] = value;
    }

    const where = whereClause.length > 0 ? `WHERE ${whereClause.join(' AND ')}` : '';
    const order = sortBy ? `ORDER BY n.${sortBy}` : '';
    const cypher = `MATCH (n${nodeLabel}) ${where} RETURN n ${order} LIMIT $limit`;

    return this.runQuery(cypher, params);
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}
