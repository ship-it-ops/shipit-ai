import neo4j, { type Driver, type Record as Neo4jRecord } from 'neo4j-driver';
import type { RequestContext } from '@shipit-ai/shared';

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
  /** True when blast-radius hit the server-side node cap; consumers should warn the user. */
  truncated?: boolean;
}

/**
 * Hard cap on blast-radius node count. APOC's `subgraphAll` happily walks
 * thousands of nodes in a fan-out; with no limit the IC's first-60-second
 * dashboard query can stall the page. The cap is enforced at the Cypher
 * layer so we never load the oversize set into memory.
 */
const MAX_BLAST_RADIUS_NODES = 200;

// Labels beginning with `_` are core-writer bookkeeping (`_LinkingKey`,
// `_IdempotencyLog`) — they have no canonical `id` property and no
// `name`, so leaking them into the graph explorer crashes Cytoscape with
// `Can not create element with invalid string ID '`. They also don't
// belong in dashboard counts. Every user-facing graph query filters them
// out via this predicate.
const EXCLUDE_INTERNAL_LABELS = "NONE(l IN labels(n) WHERE l STARTS WITH '_')";

/**
 * Project `_last_synced_age_seconds` onto a node's properties. Computed
 * server-side because corporate-laptop clock skew is real and breaks any
 * `Date.now() - lastSynced` math the client tries to do.
 */
function withStalenessAge(props: Record<string, unknown>): Record<string, unknown> {
  const lastSynced = props['_last_synced'];
  if (typeof lastSynced !== 'string') return props;
  const t = Date.parse(lastSynced);
  if (!Number.isFinite(t)) return props;
  const ageMs = Date.now() - t;
  if (ageMs < 0) return props;
  return { ...props, _last_synced_age_seconds: Math.floor(ageMs / 1000) };
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

  // The `_ctx` parameters on the user-facing methods below are the seam
  // Stage B6's org filter sits behind. They're accepted-but-unused today so
  // route handlers and tests can be wired with the right shape before the
  // filter logic lands. `runQuery` deliberately stays ctx-free — it's an
  // internal escape hatch called from worker services without a request
  // scope (claim-service, team-service, reconciliation, etc.).
  async getGraphStats(_ctx: RequestContext): Promise<GraphStats> {
    // `db.labels()` returns every label including the `_LinkingKey` /
    // `_IdempotencyLog` housekeeping ones. Strip them at the application
    // layer so the dashboard's "node count" matches what users see in the
    // explorer; the internal nodes still count toward Neo4j's storage but
    // not toward the user-facing graph.
    const nodeCountsResult = await this.runQuery(
      "CALL db.labels() YIELD label WHERE NOT label STARTS WITH '_' RETURN label, COUNT { MATCH (n) WHERE label IN labels(n) } AS count",
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

  async getNeighborhood(
    _ctx: RequestContext,
    nodeId: string,
    depth: number = 2,
  ): Promise<NeighborhoodResult> {
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
              ...withStalenessAge(node.properties),
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

  /**
   * Blast radius — entities transitively affected if the start entity is down.
   *
   * Walks *inbound* on the impact-bearing relationship types only:
   * - `DEPENDS_ON` — declared service-to-service / repo-to-repo dependency
   * - `CALLS` — runtime call dependency
   * - `MONITORS` — monitors that would fire when this entity breaks
   *
   * Other relationships (`IMPLEMENTED_BY`, `DEPLOYED_AS`, `OWNS`, `MEMBER_OF`,
   * etc.) describe structure, not impact, and are excluded. Entities with no
   * inbound impact edges (Person, Team, leaf Repositories) correctly return
   * just themselves.
   */
  async getBlastRadius(
    _ctx: RequestContext,
    nodeId: string,
    depth: number = 3,
  ): Promise<NeighborhoodResult> {
    // Ask APOC for one node beyond the cap so we can detect overflow rather
    // than silently truncate.
    const probeLimit = MAX_BLAST_RADIUS_NODES + 1;
    const records = await this.runQuery(
      `MATCH (start {id: $nodeId})
       CALL apoc.path.subgraphAll(start, {
         maxLevel: $depth,
         relationshipFilter: '<DEPENDS_ON|<CALLS|<MONITORS',
         limit: $probeLimit
       })
       YIELD nodes, relationships
       RETURN nodes,
              [rel IN relationships | {
                source: startNode(rel).id,
                target: endNode(rel).id,
                type: type(rel),
                props: properties(rel)
              }] AS rels`,
      { nodeId, depth: neo4j.int(depth), probeLimit: neo4j.int(probeLimit) },
    );

    const nodesMap = new Map<string, CytoscapeNode>();
    let edges: CytoscapeEdge[] = [];

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
              ...withStalenessAge(node.properties),
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

    let nodes = Array.from(nodesMap.values());
    let truncated = false;
    if (nodes.length > MAX_BLAST_RADIUS_NODES) {
      truncated = true;
      nodes = nodes.slice(0, MAX_BLAST_RADIUS_NODES);
      // Drop dangling edges so Cytoscape doesn't choke on missing endpoints.
      const keep = new Set(nodes.map((n) => String(n.data.id)));
      edges = edges.filter(
        (e) => keep.has(String(e.data.source)) && keep.has(String(e.data.target)),
      );
    }

    return { nodes, edges, truncated };
  }

  async getOverview(_ctx: RequestContext, limit: number = 100): Promise<NeighborhoodResult> {
    const nodeRecords = await this.runQuery(
      `MATCH (n) WHERE ${EXCLUDE_INTERNAL_LABELS} RETURN n, labels(n) AS labels LIMIT $limit`,
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
            ...withStalenessAge(node.properties),
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

  async searchEntities(
    _ctx: RequestContext,
    opts: {
      label?: string;
      /** Free-text query — matched case-insensitively against `name` and the canonical id. */
      q?: string;
      /** Exact-match filters (tier, owner, etc.) applied with `=`. */
      filters?: Record<string, unknown>;
      limit?: number;
      sortBy?: string;
    },
  ): Promise<Neo4jRecord[]> {
    const { label, q, filters = {}, limit = 25, sortBy } = opts;
    const nodeLabel = label ? `:${label}` : '';
    // Always exclude the writer's internal `_LinkingKey` / `_IdempotencyLog`
    // nodes — they don't have a user-facing `name` or canonical `id` and
    // would otherwise contaminate the global command palette.
    const whereClause: string[] = ['coalesce(n._deleted, false) = false', EXCLUDE_INTERNAL_LABELS];
    const params: Record<string, unknown> = { limit: neo4j.int(limit) };

    if (q && q.trim()) {
      // Case-insensitive substring match on name OR canonical id, so a query
      // like "payments" hits "payments-api", "payments-svc", and any node
      // whose id contains "payments". Cypher's `CONTAINS` is case-sensitive,
      // so lower-case both sides explicitly.
      whereClause.push(
        '(toLower(coalesce(n.name, "")) CONTAINS toLower($q) OR toLower(coalesce(n.id, "")) CONTAINS toLower($q))',
      );
      params.q = q.trim();
    }

    for (const [key, value] of Object.entries(filters)) {
      whereClause.push(`n.${key} = $filter_${key}`);
      params[`filter_${key}`] = value;
    }

    const where = `WHERE ${whereClause.join(' AND ')}`;
    const order = sortBy ? `ORDER BY n.${sortBy}` : 'ORDER BY n.name';
    const cypher = `MATCH (n${nodeLabel}) ${where} RETURN n, labels(n) AS labels ${order} LIMIT $limit`;

    return this.runQuery(cypher, params);
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}
