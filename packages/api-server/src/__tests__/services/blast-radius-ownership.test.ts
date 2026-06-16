import { describe, it, expect } from 'vitest';
import { Neo4jService } from '../../services/neo4j-service.js';
import type { RequestContext } from '@shipit-ai/shared';

/**
 * getBlastRadius builds its Cypher inline and runs it via runQuery. We don't
 * need a live Neo4j — stub runQuery on the instance and capture the query so we
 * can assert the relationshipFilter walks ownership edges (so a Team reaches
 * the repos/services it owns) without surfacing owners upstream.
 */
function makeService() {
  const service = new Neo4jService('bolt://localhost:7687', 'neo4j', 'test');
  const queries: string[] = [];
  // Override the real query runner with a capturing stub.
  service.runQuery = async (cypher: string) => {
    queries.push(cypher);
    return [];
  };
  return { service, queries };
}

const ctx = { org: undefined } as unknown as RequestContext;

describe('Neo4jService.getBlastRadius — ownership edges', () => {
  it('walks ownership edges outbound so a team reaches its owned repos/services', async () => {
    const { service, queries } = makeService();
    await service.getBlastRadius(ctx, 'shipit://team/default/acme/platform', 3);
    expect(queries[0]).toContain('OWNS>');
    expect(queries[0]).toContain('CODEOWNER_OF>');
  });

  it('keeps ownership downstream-only (no inbound ownership that would surface owners)', async () => {
    const { service, queries } = makeService();
    await service.getBlastRadius(ctx, 'shipit://logical-service/default/acme/config', 3);
    expect(queries[0]).not.toContain('<OWNS');
    expect(queries[0]).not.toContain('<CODEOWNER_OF');
  });

  it('still walks impact dependencies inbound', async () => {
    const { service, queries } = makeService();
    await service.getBlastRadius(ctx, 'shipit://logical-service/default/acme/config', 3);
    expect(queries[0]).toContain('<DEPENDS_ON');
    expect(queries[0]).toContain('<CALLS');
  });
});
