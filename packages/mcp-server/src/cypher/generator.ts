export interface CypherQuery {
  query: string;
  params: Record<string, unknown>;
}

export type BlastRadiusDirection = 'DOWNSTREAM' | 'UPSTREAM' | 'BOTH';

const DEPENDENCY_EDGE_PATTERN =
  'IMPLEMENTED_BY|DEPLOYED_AS|EMITS_TELEMETRY_AS|CALLS|DEPENDS_ON|BUILT_BY|TRIGGERS';

// Ownership edges are directional: an owner (Team/Person) points at what it
// owns. Included downstream only so a Team reaches its owned repos/services
// (GitHub teams own repos via CODEOWNER_OF, not OWNS); excluded upstream so a
// service's blast radius does not surface its owning team.
const OWNERSHIP_EDGE_PATTERN = 'OWNS|CODEOWNER_OF';

const DOWNSTREAM_EDGE_PATTERN = `${DEPENDENCY_EDGE_PATTERN}|${OWNERSHIP_EDGE_PATTERN}`;

const UPSTREAM_EDGE_PATTERN = DEPENDENCY_EDGE_PATTERN;

export function generateBlastRadiusCypher(
  node: string,
  depth: number,
  direction: BlastRadiusDirection,
  includeEnvironments?: string[],
): CypherQuery {
  const dirClause =
    direction === 'UPSTREAM'
      ? `<-[:${UPSTREAM_EDGE_PATTERN}*1..${depth}]-`
      : direction === 'BOTH'
        ? // Undirected: ownership edges are excluded here (they would otherwise
          // surface owners from the owned side); only dependency edges apply.
          `-[:${DEPENDENCY_EDGE_PATTERN}*1..${depth}]-`
        : `-[:${DOWNSTREAM_EDGE_PATTERN}*1..${depth}]->`;

  let envFilter = '';
  const params: Record<string, unknown> = { nodeId: node };

  if (includeEnvironments && includeEnvironments.length > 0) {
    envFilter = `
      AND (NOT n.label = 'Deployment' OR n.environment IN $environments)`;
    params.environments = includeEnvironments;
  }

  const query = `
    MATCH (start {id: $nodeId})
    MATCH path = (start)${dirClause}(n)
    WHERE n <> start${envFilter}
    WITH DISTINCT n, min(length(path)) AS depth, collect(path)[0] AS sample_path
    RETURN n AS node, depth,
           [r IN relationships(sample_path) | type(r)] AS rel_types,
           labels(n) AS labels
    ORDER BY depth ASC`;

  return { query, params };
}

export function generateEntityDetailCypher(
  entityId: string,
  includeNeighbors: boolean,
): CypherQuery {
  if (!includeNeighbors) {
    return {
      query: `
        MATCH (n {id: $entityId})
        RETURN n AS node, labels(n) AS labels`,
      params: { entityId },
    };
  }

  return {
    query: `
      MATCH (n {id: $entityId})
      OPTIONAL MATCH (n)-[r]-(neighbor)
      RETURN n AS node, labels(n) AS labels,
             collect(DISTINCT {
               neighbor: neighbor,
               neighbor_labels: labels(neighbor),
               rel_type: type(r),
               direction: CASE WHEN startNode(r) = n THEN 'outgoing' ELSE 'incoming' END
             }) AS neighbors`,
    params: { entityId },
  };
}

export function generateFindOwnersCypher(entityId: string, includeChain: boolean): CypherQuery {
  if (!includeChain) {
    return {
      query: `
        MATCH (entity {id: $entityId})
        OPTIONAL MATCH (owner)-[:OWNS]->(entity)
        OPTIONAL MATCH (codeowner)-[:CODEOWNER_OF]->(entity)
        OPTIONAL MATCH (oncall)-[:ON_CALL_FOR]->(entity)
        RETURN entity,
               collect(DISTINCT owner) AS owners,
               collect(DISTINCT codeowner) AS codeowners,
               collect(DISTINCT oncall) AS on_call`,
      params: { entityId },
    };
  }

  return {
    query: `
      MATCH (entity {id: $entityId})
      OPTIONAL MATCH (owner)-[:OWNS]->(entity)
      OPTIONAL MATCH (codeowner)-[:CODEOWNER_OF]->(entity)
      OPTIONAL MATCH (oncall)-[:ON_CALL_FOR]->(entity)
      OPTIONAL MATCH (member)-[:MEMBER_OF]->(owner)
      RETURN entity,
             collect(DISTINCT owner) AS owners,
             collect(DISTINCT codeowner) AS codeowners,
             collect(DISTINCT oncall) AS on_call,
             collect(DISTINCT member) AS members`,
    params: { entityId },
  };
}

export function generateDependencyChainCypher(
  from: string,
  to: string,
  maxDepth: number,
): CypherQuery {
  return {
    query: `
      MATCH (start {id: $from}), (end {id: $to})
      MATCH path = shortestPath((start)-[*1..${maxDepth}]-(end))
      RETURN path,
             length(path) AS path_length,
             [n IN nodes(path) | n] AS path_nodes,
             [r IN relationships(path) | {type: type(r), from: startNode(r).id, to: endNode(r).id}] AS path_edges`,
    params: { from, to },
  };
}

export function generateSearchEntitiesCypher(
  label?: string,
  propertyFilters?: Record<string, unknown>,
  limit: number = 25,
  sortBy: string = 'name',
): CypherQuery {
  const params: Record<string, unknown> = { limit };
  let matchClause = label ? `MATCH (n:\`${label}\`)` : 'MATCH (n)';
  const whereClauses: string[] = [];

  if (propertyFilters) {
    let filterIdx = 0;
    for (const [key, value] of Object.entries(propertyFilters)) {
      const paramName = `filter_${filterIdx}`;
      if (value === null) {
        whereClauses.push(`n.\`${key}\` IS NULL`);
      } else {
        whereClauses.push(`n.\`${key}\` = $${paramName}`);
        params[paramName] = value;
      }
      filterIdx++;
    }
  }

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const query = `
    ${matchClause}
    ${whereStr}
    WITH n, labels(n) AS labels
    ORDER BY n.\`${sortBy}\` ASC
    WITH count(n) AS total, collect(n)[0..toInteger($limit)] AS entities,
         collect(labels(n))[0..toInteger($limit)] AS all_labels
    RETURN total, entities, all_labels`;

  // Rewrite to avoid the nested collect issue:
  const betterQuery = `
    ${matchClause}
    ${whereStr}
    WITH count(*) AS total
    ${matchClause}
    ${whereStr}
    WITH total, n, labels(n) AS lbl
    ORDER BY n.\`${sortBy}\` ASC
    LIMIT toInteger($limit)
    RETURN total, collect({node: n, labels: lbl}) AS entities`;

  return { query: betterQuery, params };
}

export function generateGraphStatsCypher(): CypherQuery {
  return {
    query: `
      CALL {
        MATCH (n)
        UNWIND labels(n) AS label
        RETURN label, count(*) AS cnt
      }
      WITH collect({label: label, count: cnt}) AS node_counts,
           sum(cnt) AS total_nodes
      CALL {
        MATCH ()-[r]->()
        RETURN type(r) AS rel_type, count(*) AS cnt
      }
      WITH node_counts, total_nodes,
           collect({type: rel_type, count: cnt}) AS edge_counts,
           sum(cnt) AS total_edges
      CALL {
        MATCH (d:Deployment)
        RETURN collect(DISTINCT d.environment) AS environments
      }
      RETURN node_counts, total_nodes, edge_counts, total_edges, environments`,
    params: {},
  };
}
