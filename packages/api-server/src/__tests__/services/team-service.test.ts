import { describe, it, expect } from 'vitest';
import { TeamService } from '../../services/team-service.js';
import type { Neo4jService } from '../../services/neo4j-service.js';

/** A Neo4j record stub exposing the `.get(key)` accessor the service uses. */
function record(fields: Record<string, unknown>) {
  return { get: (key: string) => fields[key] };
}

/**
 * Capturing Neo4jService stub. Records every query string and returns the
 * queued responses in call order.
 */
function makeNeo4j(responses: Array<ReturnType<typeof record>[]>) {
  const queries: string[] = [];
  let call = 0;
  const neo4j = {
    runQuery: async (query: string) => {
      queries.push(query);
      return responses[call++] ?? [];
    },
  } as unknown as Neo4jService;
  return { neo4j, queries };
}

describe('TeamService.listTeams', () => {
  it('counts CODEOWNER_OF as ownership alongside OWNS (GitHub teams own repos via CODEOWNER_OF)', async () => {
    const { neo4j, queries } = makeNeo4j([[]]);
    await new TeamService(neo4j).listTeams();
    expect(queries[0]).toContain('CODEOWNER_OF');
    // Both ownership rel types in one traversal, deduped by the existing DISTINCT.
    expect(queries[0]).toMatch(/OWNS\s*\|\s*CODEOWNER_OF/);
  });

  it('maps ownedCount from the query result', async () => {
    const { neo4j } = makeNeo4j([
      [
        record({
          t: {
            properties: {
              id: 'shipit://team/default/acme/platform',
              name: 'Platform',
              slug: 'platform',
            },
          },
          ownedCount: 4,
          memberCount: 1,
          onCallCount: 0,
        }),
      ],
    ]);
    const [team] = await new TeamService(neo4j).listTeams();
    expect(team.ownedCount).toBe(4);
  });
});

describe('TeamService.getTeam', () => {
  it('traverses CODEOWNER_OF when listing what a team owns', async () => {
    const { neo4j, queries } = makeNeo4j([
      [
        record({
          t: {
            properties: {
              id: 'shipit://team/default/acme/platform',
              name: 'Platform',
              slug: 'platform',
            },
          },
        }),
      ],
      [], // owned
      [], // members
      [], // on-call
    ]);
    await new TeamService(neo4j).getTeam('shipit://team/default/acme/platform');
    const ownedQuery = queries[1];
    expect(ownedQuery).toContain('CODEOWNER_OF');
    expect(ownedQuery).toMatch(/OWNS\s*\|\s*CODEOWNER_OF/);
  });

  it('classifies CODEOWNER_OF-owned repositories into the repositories bucket', async () => {
    const { neo4j } = makeNeo4j([
      [
        record({
          t: {
            properties: {
              id: 'shipit://team/default/acme/platform',
              name: 'Platform',
              slug: 'platform',
            },
          },
        }),
      ],
      [
        record({
          n: {
            properties: { id: 'shipit://repository/default/acme/graph-api', name: 'graph-api' },
          },
          labels: ['Repository'],
        }),
      ],
      [],
      [],
    ]);
    const detail = await new TeamService(neo4j).getTeam('shipit://team/default/acme/platform');
    expect(detail?.repositories).toHaveLength(1);
    expect(detail?.ownedCount).toBe(1);
  });
});
