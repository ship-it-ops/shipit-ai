import { describe, it, expect } from 'vitest';
import {
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
});
