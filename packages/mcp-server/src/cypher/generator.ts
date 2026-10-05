import { DEPENDENCY_EDGE_PATTERN, OWNERSHIP_EDGE_PATTERN } from '@shipit-ai/shared';

export interface CypherQuery {
  query: string;
  params: Record<string, unknown>;
}

export type BlastRadiusDirection = 'DOWNSTREAM' | 'UPSTREAM' | 'BOTH';

const DOWNSTREAM_EDGE_PATTERN = `${DEPENDENCY_EDGE_PATTERN}|${OWNERSHIP_EDGE_PATTERN}`;

const UPSTREAM_EDGE_PATTERN = DEPENDENCY_EDGE_PATTERN;

// Nodes whose label starts with an underscore are the application's own
// bookkeeping (access tokens, linking keys, the idempotency log), not part of
// the catalog. No structured tool finds, lists, counts or passes through one.
const notInternal = (alias: string): string =>
  `NONE(l IN labels(${alias}) WHERE l STARTS WITH '_')`;

/** Every id a caller could have meant: what "did you mean" suggestions are drawn from. */
export const CATALOG_NODE_IDS_CYPHER = `MATCH (n) WHERE n.id IS NOT NULL AND ${notInternal('n')} RETURN n.id AS id`;

/** Whether `$nodeId` names a catalog node. */
export const CATALOG_NODE_EXISTS_CYPHER = `MATCH (n {id: $nodeId}) WHERE ${notInternal('n')} RETURN n.id AS id`;

export function generateBlastRadiusCypher(
  node: string,
  depth: number,
  direction: BlastRadiusDirection,
  includeEnvironments?: string[],
  includeAbsent = false,
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

  const absentFilter = includeAbsent ? '' : `\n      AND n._absent_since IS NULL`;

  const query = `
    MATCH (start {id: $nodeId}) WHERE ${notInternal('start')}
    MATCH path = (start)${dirClause}(n)
    WHERE n <> start${envFilter}${absentFilter}
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
  includeAbsent = false,
): CypherQuery {
  if (!includeNeighbors) {
    return {
      query: `
        MATCH (n {id: $entityId}) WHERE ${notInternal('n')}
        RETURN n AS node, labels(n) AS labels`,
      params: { entityId },
    };
  }

  return {
    query: `
      MATCH (n {id: $entityId}) WHERE ${notInternal('n')}
      OPTIONAL MATCH (n)-[r]-(neighbor) WHERE ${notInternal('neighbor')}${includeAbsent ? '' : ' AND neighbor._absent_since IS NULL'}
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

export function generateFindOwnersCypher(
  entityId: string,
  includeChain: boolean,
  includeAbsent = false,
): CypherQuery {
  // The echoed entity is filtered too: the caller asked about a specific id, and
  // a swept entity must not come back looking live unless it was asked for.
  const absent = (alias: string) => (includeAbsent ? '' : ` WHERE ${alias}._absent_since IS NULL`);
  const entityMatch = `MATCH (entity {id: $entityId}) WHERE ${notInternal('entity')}${
    includeAbsent ? '' : ' AND entity._absent_since IS NULL'
  }`;

  if (!includeChain) {
    return {
      query: `
        ${entityMatch}
        OPTIONAL MATCH (owner)-[:OWNS]->(entity)${absent('owner')}
        OPTIONAL MATCH (codeowner)-[:CODEOWNER_OF]->(entity)${absent('codeowner')}
        OPTIONAL MATCH (oncall)-[:ON_CALL_FOR]->(entity)${absent('oncall')}
        RETURN entity,
               collect(DISTINCT owner) AS owners,
               collect(DISTINCT codeowner) AS codeowners,
               collect(DISTINCT oncall) AS on_call`,
      params: { entityId },
    };
  }

  return {
    query: `
      ${entityMatch}
      OPTIONAL MATCH (owner)-[:OWNS]->(entity)${absent('owner')}
      OPTIONAL MATCH (codeowner)-[:CODEOWNER_OF]->(entity)${absent('codeowner')}
      OPTIONAL MATCH (oncall)-[:ON_CALL_FOR]->(entity)${absent('oncall')}
      OPTIONAL MATCH (member)-[:MEMBER_OF]->(owner)${absent('member')}
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
  includeAbsent = false,
): CypherQuery {
  return {
    query: `
      MATCH (start {id: $from}), (end {id: $to})
      WHERE ${notInternal('start')} AND ${notInternal('end')}
      MATCH path = shortestPath((start)-[*1..${maxDepth}]-(end))
      WHERE none(x IN nodes(path) WHERE any(l IN labels(x) WHERE l STARTS WITH '_'))${
        includeAbsent ? '' : ' AND none(x IN nodes(path) WHERE x._absent_since IS NOT NULL)'
      }
      RETURN path,
             length(path) AS path_length,
             [n IN nodes(path) | n] AS path_nodes,
             [r IN relationships(path) | {type: type(r), from: startNode(r).id, to: endNode(r).id}] AS path_edges`,
    params: { from, to },
  };
}

// A label or property name is written into the query text, where a parameter
// cannot go. Only a plain identifier is accepted: a backtick would end the
// quoted name, and the rest of the value would be read as Cypher. A label may
// not start with an underscore (those are internal nodes, which the query
// excludes whatever the label); a property may (_absent_since).
export const LABEL_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
export const PROPERTY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** A label or property name that cannot be written into a query. */
export class CypherIdentifierError extends Error {
  constructor(field: string, expected: string) {
    super(`${field} must be ${expected}: letters, digits and underscores only.`);
    this.name = 'CypherIdentifierError';
  }
}

function labelIdentifier(value: string): string {
  if (!LABEL_PATTERN.test(value)) {
    throw new CypherIdentifierError('label', 'a node label that starts with a letter');
  }
  return value;
}

function propertyIdentifier(field: string, value: string): string {
  if (!PROPERTY_PATTERN.test(value)) throw new CypherIdentifierError(field, 'a property name');
  return value;
}

export function generateSearchEntitiesCypher(
  labelFilter?: string,
  propertyFilters?: Record<string, unknown>,
  limit: number = 25,
  sortBy: string = 'name',
  includeAbsent = false,
): CypherQuery {
  const params: Record<string, unknown> = { limit };
  const matchClause = labelFilter ? `MATCH (n:\`${labelIdentifier(labelFilter)}\`)` : 'MATCH (n)';
  const sortKey = propertyIdentifier('sort_by', sortBy);
  const whereClauses: string[] = [];

  if (propertyFilters) {
    let filterIdx = 0;
    for (const [rawKey, value] of Object.entries(propertyFilters)) {
      const key = propertyIdentifier('property_filters keys', rawKey);
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

  // Also with a label: a label filter cannot name an internal node, but the
  // search with no label at all would otherwise return every one of them.
  whereClauses.push(notInternal('n'));
  if (!includeAbsent) whereClauses.push('n._absent_since IS NULL');

  const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const query = `
    ${matchClause}
    ${whereStr}
    WITH n, labels(n) AS labels
    ORDER BY n.\`${sortKey}\` ASC
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
    ORDER BY n.\`${sortKey}\` ASC
    LIMIT toInteger($limit)
    RETURN total, collect({node: n, labels: lbl}) AS entities`;

  return { query: betterQuery, params };
}

export function generateGraphStatsCypher(includeAbsent = false): CypherQuery {
  const nodeWhere = ` WHERE ${notInternal('n')}${includeAbsent ? '' : ' AND n._absent_since IS NULL'}`;
  const edgeWhere = ` WHERE ${notInternal('a')} AND ${notInternal('b')}${
    includeAbsent ? '' : ' AND a._absent_since IS NULL AND b._absent_since IS NULL'
  }`;
  const deploymentWhere = includeAbsent ? '' : ' WHERE d._absent_since IS NULL';
  return {
    query: `
      CALL {
        MATCH (n)${nodeWhere}
        UNWIND labels(n) AS label
        RETURN label, count(*) AS cnt
      }
      WITH collect({label: label, count: cnt}) AS node_counts,
           sum(cnt) AS total_nodes
      CALL {
        MATCH (a)-[r]->(b)${edgeWhere}
        RETURN type(r) AS rel_type, count(*) AS cnt
      }
      WITH node_counts, total_nodes,
           collect({type: rel_type, count: cnt}) AS edge_counts,
           sum(cnt) AS total_edges
      CALL {
        MATCH (d:Deployment)${deploymentWhere}
        RETURN collect(DISTINCT d.environment) AS environments
      }
      RETURN node_counts, total_nodes, edge_counts, total_edges, environments`,
    params: {},
  };
}
