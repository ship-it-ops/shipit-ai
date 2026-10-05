import { describe, it, expect } from 'vitest';
import {
  CATALOG_NODE_EXISTS_CYPHER,
  CATALOG_NODE_IDS_CYPHER,
  generateBlastRadiusCypher,
  generateEntityDetailCypher,
  generateFindOwnersCypher,
  generateDependencyChainCypher,
  generateSearchEntitiesCypher,
  generateGraphStatsCypher,
} from '../cypher/generator.js';

describe('Cypher Generator', () => {
  describe('generateBlastRadiusCypher', () => {
    it('should generate downstream traversal query', () => {
      const result = generateBlastRadiusCypher(
        'shipit://logical-service/default/config-service',
        3,
        'DOWNSTREAM',
      );
      expect(result.query).toContain('MATCH (start {id: $nodeId})');
      expect(result.query).toContain('*1..3');
      expect(result.params.nodeId).toBe('shipit://logical-service/default/config-service');
    });

    it('should generate upstream traversal query', () => {
      const result = generateBlastRadiusCypher(
        'shipit://logical-service/default/config-service',
        3,
        'UPSTREAM',
      );
      expect(result.query).toContain('<-[');
      expect(result.params.nodeId).toBe('shipit://logical-service/default/config-service');
    });

    it('should generate bidirectional traversal query', () => {
      const result = generateBlastRadiusCypher(
        'shipit://logical-service/default/config-service',
        3,
        'BOTH',
      );
      expect(result.query).toContain('-[:');
      expect(result.query).not.toContain('->');
      expect(result.query).not.toContain('<-');
    });

    it('should include environment filter when specified', () => {
      const result = generateBlastRadiusCypher('node', 3, 'DOWNSTREAM', ['production']);
      expect(result.query).toContain('$environments');
      expect(result.params.environments).toEqual(['production']);
    });

    it('should respect depth parameter', () => {
      const result = generateBlastRadiusCypher('node', 5, 'DOWNSTREAM');
      expect(result.query).toContain('*1..5');
    });

    it('traverses ownership edges downstream so a team reaches its owned repos/services', () => {
      // GitHub teams own repos via CODEOWNER_OF (and services via OWNS).
      // Without these in the pattern, a Team node's blast radius is empty.
      const result = generateBlastRadiusCypher(
        'shipit://team/default/acme/platform',
        3,
        'DOWNSTREAM',
      );
      expect(result.query).toContain('OWNS');
      expect(result.query).toContain('CODEOWNER_OF');
    });

    it('does NOT pull ownership edges into upstream traversal', () => {
      // Downstream-only: a service should not surface its owning team upstream.
      const result = generateBlastRadiusCypher(
        'shipit://logical-service/default/acme/config',
        3,
        'UPSTREAM',
      );
      expect(result.query).not.toContain('CODEOWNER_OF');
    });
  });

  describe('generateEntityDetailCypher', () => {
    it('should generate query without neighbors', () => {
      const result = generateEntityDetailCypher('entity-id', false);
      expect(result.query).toContain('MATCH (n {id: $entityId})');
      expect(result.query).not.toContain('neighbor');
      expect(result.params.entityId).toBe('entity-id');
    });

    it('should generate query with neighbors', () => {
      const result = generateEntityDetailCypher('entity-id', true);
      expect(result.query).toContain('OPTIONAL MATCH (n)-[r]-(neighbor)');
      expect(result.query).toContain('neighbor_labels');
    });
  });

  describe('generateFindOwnersCypher', () => {
    it('should generate basic ownership query', () => {
      const result = generateFindOwnersCypher('entity-id', false);
      expect(result.query).toContain('OWNS');
      expect(result.query).toContain('CODEOWNER_OF');
      expect(result.query).toContain('ON_CALL_FOR');
      expect(result.query).not.toContain('MEMBER_OF');
    });

    it('should include chain when requested', () => {
      const result = generateFindOwnersCypher('entity-id', true);
      expect(result.query).toContain('MEMBER_OF');
      expect(result.query).toContain('members');
    });
  });

  describe('generateDependencyChainCypher', () => {
    it('should generate shortest path query', () => {
      const result = generateDependencyChainCypher('from-id', 'to-id', 6);
      expect(result.query).toContain('shortestPath');
      expect(result.query).toContain('*1..6');
      expect(result.params.from).toBe('from-id');
      expect(result.params.to).toBe('to-id');
    });

    it('should respect max depth', () => {
      const result = generateDependencyChainCypher('from-id', 'to-id', 10);
      expect(result.query).toContain('*1..10');
    });
  });

  describe('generateSearchEntitiesCypher', () => {
    it('should generate query with label filter', () => {
      const result = generateSearchEntitiesCypher('LogicalService');
      expect(result.query).toContain('`LogicalService`');
    });

    it('should generate query without label filter', () => {
      const result = generateSearchEntitiesCypher();
      expect(result.query).toContain('MATCH (n)');
    });

    it('should include property filters', () => {
      const result = generateSearchEntitiesCypher('LogicalService', { tier_effective: 1 });
      expect(result.query).toContain('`tier_effective`');
      expect(result.params.filter_0).toBe(1);
    });

    it('should handle null filter values', () => {
      const result = generateSearchEntitiesCypher('LogicalService', { owner: null });
      expect(result.query).toContain('IS NULL');
    });

    it('should respect limit parameter', () => {
      const result = generateSearchEntitiesCypher(undefined, undefined, 50);
      expect(result.params.limit).toBe(50);
    });

    // The label, the filter keys and the sort key are written into the query
    // as identifiers, so anything that is not a plain identifier is refused:
    // a backtick would end the identifier and the rest would run as Cypher.
    it('refuses a label that is not a plain identifier', () => {
      expect(() => generateSearchEntitiesCypher('Repository`) MATCH (m')).toThrow(/label/);
      expect(() => generateSearchEntitiesCypher('Logical Service')).toThrow(/label/);
      expect(() => generateSearchEntitiesCypher('Repository\\u0060')).toThrow(/label/);
    });

    it('refuses an internal label', () => {
      expect(() => generateSearchEntitiesCypher('_AccessToken')).toThrow(/label/);
    });

    it('refuses a filter key that is not a plain identifier', () => {
      expect(() =>
        generateSearchEntitiesCypher('Repository', { 'name` IS NOT NULL OR n.`x': 1 }),
      ).toThrow(/property_filters/);
      expect(() => generateSearchEntitiesCypher('Repository', { '': null })).toThrow(
        /property_filters/,
      );
    });

    it('refuses a sort key that is not a plain identifier', () => {
      expect(() =>
        generateSearchEntitiesCypher('Repository', undefined, 25, 'name` DESC //'),
      ).toThrow(/sort_by/);
    });

    it('accepts property names that start with an underscore', () => {
      const result = generateSearchEntitiesCypher(
        'Repository',
        { _event_version: 3 },
        25,
        '_absent_since',
      );
      expect(result.query).toContain('n.`_event_version` = $filter_0');
      expect(result.query).toContain('ORDER BY n.`_absent_since` ASC');
    });
  });

  describe('generateGraphStatsCypher', () => {
    it('should generate stats query', () => {
      const result = generateGraphStatsCypher();
      expect(result.query).toContain('labels(n)');
      expect(result.query).toContain('type(r)');
      expect(result.query).toContain('environments');
      expect(result.params).toEqual({});
    });
  });

  describe('absent-node filtering (sync sweep)', () => {
    const id = 'shipit://repository/default/Ship-It-Ops/ShipIt-AI';

    it('blast radius excludes absent nodes by default and includes them on request', () => {
      expect(generateBlastRadiusCypher(id, 2, 'BOTH').query).toContain('n._absent_since IS NULL');
      expect(generateBlastRadiusCypher(id, 2, 'BOTH', undefined, true).query).not.toContain(
        '_absent_since',
      );
    });

    it('entity detail neighbors exclude absent nodes by default', () => {
      expect(generateEntityDetailCypher(id, true).query).toContain(
        'AND neighbor._absent_since IS NULL',
      );
      expect(generateEntityDetailCypher(id, true, true).query).not.toContain('_absent_since');
      // The entity itself is never filtered: asking for an absent node by id still works.
      expect(generateEntityDetailCypher(id, false).query).not.toContain('_absent_since');
    });

    it('dependency chain refuses paths through absent nodes by default', () => {
      expect(generateDependencyChainCypher(id, 'x', 3).query).toContain(
        'none(x IN nodes(path) WHERE x._absent_since IS NOT NULL)',
      );
      expect(generateDependencyChainCypher(id, 'x', 3, true).query).not.toContain('_absent_since');
    });

    it('search excludes absent nodes by default, also when no other filter is set', () => {
      expect(generateSearchEntitiesCypher().query).toContain('AND n._absent_since IS NULL');
      expect(
        generateSearchEntitiesCypher(undefined, undefined, 25, 'name', true).query,
      ).not.toContain('_absent_since');
    });

    it('graph stats exclude absent nodes and their edges by default, and include them on request', () => {
      const q = generateGraphStatsCypher().query;
      expect(q).toMatch(/MATCH \(n\) WHERE .* AND n\._absent_since IS NULL/);
      expect(q).toContain('a._absent_since IS NULL AND b._absent_since IS NULL');
      expect(q).toContain('MATCH (d:Deployment) WHERE d._absent_since IS NULL');
      // Every read accepts include_absent; graph_stats used to hard-code the exclusion.
      expect(generateGraphStatsCypher(true).query).not.toContain('_absent_since');
    });

    it('find_owners excludes absent owners, codeowners, on-call, members and the echoed entity', () => {
      const q = generateFindOwnersCypher(id, true).query;
      for (const alias of ['entity', 'owner', 'codeowner', 'oncall', 'member']) {
        expect(q).toContain(`${alias}._absent_since IS NULL`);
      }
      // Without include_chain there is no `member` leg, but the rest still filter.
      const shallow = generateFindOwnersCypher(id, false).query;
      for (const alias of ['entity', 'owner', 'codeowner', 'oncall']) {
        expect(shallow).toContain(`${alias}._absent_since IS NULL`);
      }
      expect(generateFindOwnersCypher(id, true, true).query).not.toContain('_absent_since');
      expect(generateFindOwnersCypher(id, false, true).query).not.toContain('_absent_since');
    });
  });

  // Nodes whose label starts with an underscore are the application's own
  // bookkeeping: access tokens, linking keys, the idempotency log. They are not
  // part of the catalog. A label filter cannot name one, but that alone does
  // not keep a tool off them: a search with no label, or a lookup by id, would
  // still reach them.
  describe('internal nodes', () => {
    const notInternal = (alias: string) => `NONE(l IN labels(${alias}) WHERE l STARTS WITH '_')`;
    const id = 'shipit://repository/default/acme/payments';

    it('search leaves them out, with or without a label', () => {
      expect(generateSearchEntitiesCypher().query).toContain(notInternal('n'));
      expect(generateSearchEntitiesCypher(undefined, { revoked: false }).query).toContain(
        notInternal('n'),
      );
      expect(generateSearchEntitiesCypher('Repository').query).toContain(notInternal('n'));
    });

    it('entity detail does not find one by id, or list one as a neighbor', () => {
      expect(generateEntityDetailCypher(id, false).query).toContain(notInternal('n'));
      const withNeighbors = generateEntityDetailCypher(id, true).query;
      expect(withNeighbors).toContain(notInternal('n'));
      expect(withNeighbors).toContain(notInternal('neighbor'));
      // Also when absent nodes are asked for: that option is about the sweep.
      expect(generateEntityDetailCypher(id, true, true).query).toContain(notInternal('neighbor'));
    });

    it('find owners does not answer for one', () => {
      for (const chain of [false, true]) {
        for (const absent of [false, true]) {
          expect(generateFindOwnersCypher(id, chain, absent).query).toContain(
            notInternal('entity'),
          );
        }
      }
    });

    it('blast radius does not start from one', () => {
      expect(generateBlastRadiusCypher(id, 2, 'BOTH').query).toContain(notInternal('start'));
    });

    it('a dependency chain does not start at, end at or pass through one', () => {
      for (const absent of [false, true]) {
        const { query } = generateDependencyChainCypher(id, 'x', 3, absent);
        expect(query).toContain(notInternal('start'));
        expect(query).toContain(notInternal('end'));
        expect(query).toContain(
          `none(x IN nodes(path) WHERE any(l IN labels(x) WHERE l STARTS WITH '_'))`,
        );
      }
    });

    it('graph stats count neither them nor their edges', () => {
      for (const absent of [false, true]) {
        const { query } = generateGraphStatsCypher(absent);
        expect(query).toContain(notInternal('n'));
        expect(query).toContain(notInternal('a'));
        expect(query).toContain(notInternal('b'));
      }
    });

    it('the id listing behind "did you mean" and the existence check leave them out', () => {
      expect(CATALOG_NODE_IDS_CYPHER).toContain('n.id IS NOT NULL');
      expect(CATALOG_NODE_IDS_CYPHER).toContain(notInternal('n'));
      expect(CATALOG_NODE_EXISTS_CYPHER).toContain('MATCH (n {id: $nodeId})');
      expect(CATALOG_NODE_EXISTS_CYPHER).toContain(notInternal('n'));
    });
  });
});
