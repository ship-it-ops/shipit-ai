import { describe, expect, it } from 'vitest';
import type { GraphData } from '../api';
import {
  blastRadiusSummary,
  directDependencies,
  directDependents,
  findService,
  monitorsFor,
  oldestSyncAgeSeconds,
  rankedBlastRadius,
  recentChanges,
  responders,
  safetyVerdict,
} from './derivations';

const SVC = 'shipit://logical-service/default/payments-api';
const DEP_SVC = 'shipit://logical-service/default/auth-service';
const CALLER_SVC = 'shipit://logical-service/default/checkout-api';
const REPO = 'shipit://repository/default/payments-api';
const DEPLOYMENT = 'shipit://deployment/default/payments-api-prod';
const PIPELINE = 'shipit://pipeline/default/payments-api-cd';
const MONITOR = 'shipit://monitor/default/payments-api-p99';
const PERSON_ON_CALL = 'shipit://person/default/alice';
const PERSON_OWNER = 'shipit://person/default/bob';
const TEAM = 'shipit://team/default/payments-team';

function graph(parts: { nodes: GraphData['nodes']; edges: GraphData['edges'] }): GraphData {
  return parts;
}

function svcNode(id: string, props: Record<string, unknown> = {}): GraphData['nodes'][number] {
  return {
    data: {
      id,
      label: 'LogicalService',
      name: id.split('/').pop() ?? id,
      type: 'LogicalService',
      ...props,
    },
  };
}

function node(
  id: string,
  type: string,
  props: Record<string, unknown> = {},
): GraphData['nodes'][number] {
  return {
    data: { id, label: type, name: id.split('/').pop() ?? id, type, ...props },
  };
}

function edge(source: string, target: string, type: string): GraphData['edges'][number] {
  return { data: { id: `${source}->${target}->${type}`, source, target, type } };
}

describe('findService', () => {
  it('returns undefined when graph is missing', () => {
    expect(findService(undefined, SVC)).toBeUndefined();
  });

  it('returns undefined when service is not in graph', () => {
    expect(findService(graph({ nodes: [], edges: [] }), SVC)).toBeUndefined();
  });

  it('parses the canonical fields', () => {
    const g = graph({
      nodes: [
        svcNode(SVC, {
          tier: 1,
          lifecycle: 'production',
          environment: 'prod',
          owner: 'payments-team',
          dd_service: 'payments-api',
          contains_pii: true,
          _last_synced: '2026-05-13T12:00:00Z',
          _last_synced_age_seconds: 600,
        }),
      ],
      edges: [],
    });
    const svc = findService(g, SVC);
    expect(svc).toMatchObject({
      id: SVC,
      tier: 1,
      lifecycle: 'production',
      ddService: 'payments-api',
      hasPii: true,
      lastSyncedAgeSeconds: 600,
    });
  });

  it('prefers tier_effective over tier when both exist', () => {
    const g = graph({
      nodes: [svcNode(SVC, { tier: 3, tier_effective: 1 })],
      edges: [],
    });
    expect(findService(g, SVC)?.tier).toBe(1);
  });
});

describe('directDependencies / directDependents', () => {
  const g = graph({
    nodes: [svcNode(SVC), svcNode(DEP_SVC), svcNode(CALLER_SVC)],
    edges: [edge(SVC, DEP_SVC, 'DEPENDS_ON'), edge(CALLER_SVC, SVC, 'CALLS')],
  });

  it('returns outbound DEPENDS_ON / CALLS targets', () => {
    expect(directDependencies(g, SVC).map((d) => d.id)).toEqual([DEP_SVC]);
  });

  it('returns inbound DEPENDS_ON / CALLS sources', () => {
    expect(directDependents(g, SVC).map((d) => d.id)).toEqual([CALLER_SVC]);
  });

  it('ignores non-dependency edges', () => {
    const onlyOwns = graph({
      nodes: [svcNode(SVC), svcNode(DEP_SVC)],
      edges: [edge(SVC, DEP_SVC, 'OWNS')],
    });
    expect(directDependencies(onlyOwns, SVC)).toEqual([]);
  });
});

describe('rankedBlastRadius', () => {
  it('sorts T1 above T2 above T3 above unknown, then by inbound-degree, then by name', () => {
    const g = graph({
      nodes: [
        svcNode(SVC),
        svcNode('shipit://logical-service/default/a-t3', { tier: 3 }),
        svcNode('shipit://logical-service/default/b-t1', { tier: 1 }),
        svcNode('shipit://logical-service/default/c-t1', { tier: 1 }),
        svcNode('shipit://logical-service/default/d-t2', { tier: 2 }),
      ],
      edges: [
        // Two edges into c-t1, one into b-t1 — c should rank above b.
        edge(
          'shipit://logical-service/default/a-t3',
          'shipit://logical-service/default/c-t1',
          'DEPENDS_ON',
        ),
        edge(
          'shipit://logical-service/default/d-t2',
          'shipit://logical-service/default/c-t1',
          'CALLS',
        ),
        edge(
          'shipit://logical-service/default/a-t3',
          'shipit://logical-service/default/b-t1',
          'DEPENDS_ON',
        ),
      ],
    });
    const ranked = rankedBlastRadius(g, SVC).map((e) => e.id);
    expect(ranked).toEqual([
      'shipit://logical-service/default/c-t1',
      'shipit://logical-service/default/b-t1',
      'shipit://logical-service/default/d-t2',
      'shipit://logical-service/default/a-t3',
    ]);
  });

  it('excludes the start node', () => {
    const g = graph({
      nodes: [svcNode(SVC, { tier: 1 }), svcNode(DEP_SVC, { tier: 2 })],
      edges: [],
    });
    expect(rankedBlastRadius(g, SVC).map((e) => e.id)).toEqual([DEP_SVC]);
  });
});

describe('recentChanges', () => {
  it('returns connected change-type nodes sorted by sync age ascending', () => {
    const g = graph({
      nodes: [
        svcNode(SVC),
        node(DEPLOYMENT, 'Deployment', { _last_synced_age_seconds: 1200 }),
        node(PIPELINE, 'Pipeline', { _last_synced_age_seconds: 60 }),
      ],
      edges: [edge(SVC, DEPLOYMENT, 'DEPLOYED_AS'), edge(SVC, PIPELINE, 'BUILT_BY')],
    });
    const changes = recentChanges(g, SVC, 5).map((c) => c.id);
    expect(changes).toEqual([PIPELINE, DEPLOYMENT]);
  });

  it('extracts a real event time into changedAt when the node reports one', () => {
    const g = graph({
      nodes: [
        svcNode(SVC),
        node(PIPELINE, 'Pipeline', {
          _last_synced_age_seconds: 60,
          last_run_at: '2026-06-25T18:00:00.000Z',
        }),
        node(DEPLOYMENT, 'Deployment', { _last_synced_age_seconds: 120 }),
      ],
      edges: [edge(SVC, PIPELINE, 'BUILT_BY'), edge(SVC, DEPLOYMENT, 'DEPLOYED_AS')],
    });
    const byId = new Map(recentChanges(g, SVC, 5).map((c) => [c.id, c]));
    expect(byId.get(PIPELINE)?.changedAt).toBe('2026-06-25T18:00:00.000Z');
    // Deployment carries no event-time field → changedAt stays undefined.
    expect(byId.get(DEPLOYMENT)?.changedAt).toBeUndefined();
  });

  it('caps to limit', () => {
    const nodes = [svcNode(SVC)];
    const edges: GraphData['edges'] = [];
    for (let i = 0; i < 10; i++) {
      const id = `shipit://deployment/default/d-${i}`;
      nodes.push(node(id, 'Deployment', { _last_synced_age_seconds: i * 60 }));
      edges.push(edge(SVC, id, 'DEPLOYED_AS'));
    }
    expect(recentChanges(graph({ nodes, edges }), SVC, 3)).toHaveLength(3);
  });
});

describe('monitorsFor', () => {
  it('returns Monitor nodes connected via inbound MONITORS', () => {
    const g = graph({
      nodes: [svcNode(SVC), node(MONITOR, 'Monitor', { dd_monitor_id: '12345' })],
      edges: [edge(MONITOR, SVC, 'MONITORS')],
    });
    const ms = monitorsFor(g, SVC);
    expect(ms).toHaveLength(1);
    expect(ms[0]).toMatchObject({ id: MONITOR, ddMonitorId: '12345' });
  });
});

describe('responders', () => {
  it('separates on-call, owning teams, and code owners', () => {
    const g = graph({
      nodes: [
        svcNode(SVC),
        node(REPO, 'Repository'),
        node(PERSON_ON_CALL, 'Person', { login: 'alice', email: 'alice@x.io' }),
        node(PERSON_OWNER, 'Person', { login: 'bob' }),
        node(TEAM, 'Team', { slug: 'payments-team', email: 'p@x.io' }),
      ],
      edges: [
        edge(PERSON_ON_CALL, SVC, 'ON_CALL_FOR'),
        edge(TEAM, SVC, 'OWNS'),
        edge(SVC, REPO, 'IMPLEMENTED_BY'),
        edge(PERSON_OWNER, REPO, 'CODEOWNER_OF'),
        edge(TEAM, REPO, 'CODEOWNER_OF'),
      ],
    });
    const r = responders(g, SVC);
    expect(r.onCall.map((p) => p.id)).toEqual([PERSON_ON_CALL]);
    expect(r.owningTeams.map((t) => t.id)).toEqual([TEAM]);
    expect(r.codeOwners.teams.map((t) => t.id)).toEqual([TEAM]);
    expect(r.codeOwners.people.map((p) => p.id)).toEqual([PERSON_OWNER]);
  });
});

describe('safetyVerdict', () => {
  const baseSvc = (overrides: Record<string, unknown> = {}) =>
    findService(graph({ nodes: [svcNode(SVC, overrides)], edges: [] }), SVC);

  it('returns RED for tier 1 services', () => {
    expect(safetyVerdict(baseSvc({ tier: 1 }), []).level).toBe('red');
  });

  it('returns RED when any T1 dependent exists', () => {
    const svc = baseSvc({ tier: 3 });
    const v = safetyVerdict(svc, [{ id: 'x', name: 'x', type: 'LogicalService', tier: 1 }]);
    expect(v.level).toBe('red');
  });

  it('returns YELLOW for tier 2', () => {
    expect(safetyVerdict(baseSvc({ tier: 2 }), []).level).toBe('yellow');
  });

  it('returns YELLOW when blast radius is large even at tier 3', () => {
    const svc = baseSvc({ tier: 3 });
    const blast = Array.from({ length: 6 }).map((_, i) => ({
      id: `s${i}`,
      name: `s${i}`,
      type: 'LogicalService',
      tier: 3,
    }));
    expect(safetyVerdict(svc, blast).level).toBe('yellow');
  });

  it('returns GREEN only when tier 3 + zero blast + experimental/deprecated lifecycle', () => {
    expect(safetyVerdict(baseSvc({ tier: 3, lifecycle: 'deprecated' }), []).level).toBe('green');
    expect(safetyVerdict(baseSvc({ tier: 3, lifecycle: 'experimental' }), []).level).toBe('green');
    // production tier-3 with no blast — still YELLOW (default cautious).
    expect(safetyVerdict(baseSvc({ tier: 3, lifecycle: 'production' }), []).level).toBe('yellow');
  });

  it('returns YELLOW for PII services even when small', () => {
    expect(
      safetyVerdict(baseSvc({ tier: 3, lifecycle: 'production', contains_pii: true }), []).level,
    ).toBe('yellow');
  });

  it('returns unknown when service is missing', () => {
    expect(safetyVerdict(undefined, []).level).toBe('unknown');
  });

  it('always populates reasons', () => {
    const v = safetyVerdict(baseSvc({ tier: 1, lifecycle: 'production' }), []);
    expect(v.reasons.length).toBeGreaterThan(0);
    expect(v.reasons.some((r) => r.includes('T1'))).toBe(true);
  });
});

describe('blastRadiusSummary', () => {
  it('counts tier breakdown and unique owners', () => {
    const summary = blastRadiusSummary([
      { id: 'a', name: 'a', type: 'LogicalService', tier: 1, owner: 'team-x' },
      { id: 'b', name: 'b', type: 'LogicalService', tier: 2, owner: 'team-x' },
      { id: 'c', name: 'c', type: 'LogicalService', tier: 1, owner: 'team-y' },
    ]);
    expect(summary).toEqual({ total: 3, tier1: 2, tier2: 1, byOwner: 2 });
  });
});

describe('oldestSyncAgeSeconds', () => {
  it('returns the maximum age across nodes', () => {
    expect(
      oldestSyncAgeSeconds([
        { data: { _last_synced_age_seconds: 100 } },
        { data: { _last_synced_age_seconds: 500 } },
        { data: { _last_synced_age_seconds: 200 } },
      ]),
    ).toBe(500);
  });

  it('returns undefined when no node has an age', () => {
    expect(oldestSyncAgeSeconds([{ data: {} }, { data: { other: 1 } }])).toBeUndefined();
  });
});
