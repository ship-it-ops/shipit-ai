// Service-level unit tests for the manual RELATIONS write path (v1b, T1b+T3).
//
// Unit/inject-level: Neo4j is a small in-memory FAKE that understands the exact
// handful of Cypher the service issues (endpoint OPTIONAL MATCH, edge MERGE,
// edge probe/count, edge DELETE, GraphEditEvent CREATE). Real-Neo4j integration
// is the separate T5b task. Coverage:
//   - add creates a manual edge stamped with _manual_actor + provenance
//   - add over an existing CONNECTOR edge is a no-op (created:false,
//     preexistingConnectorEdge:true) leaving its provenance + properties intact
//   - add over the actor's own manual edge is idempotent (created:false)
//   - type not in schema → 400-class RelationEditValidationError
//   - injection-y raw type + a value that sanitizes-to-an-allowlisted-type → 400
//     (validated on the RAW value, pre-sanitize)
//   - self-loop → 400
//   - missing endpoint (from/to) → 404
//   - delete removes a manual edge (+ relation_removed audit)
//   - delete of a connector edge → 409
//   - delete of an absent edge → idempotent false (route 204)
//   - relation_added / relation_removed GraphEditEvents are written
import { describe, it, expect, beforeEach } from 'vitest';
import { getSourceReliability } from '@shipit-ai/shared';
import {
  RelationEditService,
  RelationEditValidationError,
  RelationEditNotFoundError,
  RelationEditConflictError,
} from '../../services/relation-edit-service.js';

const MANUAL_RELIABILITY = getSourceReliability('manual').reliability;

interface FakeNode {
  labels: string[];
}
interface FakeEdge {
  from: string;
  to: string;
  type: string;
  props: Record<string, unknown>;
}

// In-memory graph understanding the relation service's Cypher shapes. Each
// branch is matched by a distinct fragment of the query string.
class FakeNeo4j {
  nodes = new Map<string, FakeNode>();
  edges: FakeEdge[] = [];
  events: Record<string, unknown>[] = [];

  seedNode(id: string, label: string) {
    this.nodes.set(id, { labels: [label] });
  }
  seedEdge(edge: FakeEdge) {
    this.edges.push(edge);
  }

  private run(cypher: string, p: Record<string, unknown> = {}): { records: unknown[] } {
    // Audit event.
    if (cypher.includes('CREATE (e:GraphEditEvent')) {
      this.events.push({ ...p });
      return { records: [] };
    }
    // Endpoint existence + labels.
    if (cypher.includes('OPTIONAL MATCH')) {
      const from = this.nodes.get(p.from as string);
      const to = this.nodes.get(p.to as string);
      return {
        records: [
          {
            get: (k: string) => {
              if (k === 'fromExists') return !!from;
              if (k === 'toExists') return !!to;
              if (k === 'fromLabels') return from?.labels ?? [];
              if (k === 'toLabels') return to?.labels ?? [];
              return undefined;
            },
          },
        ],
      };
    }
    // Edge MERGE.
    if (cypher.includes('MERGE (from)-[r:')) {
      const type = matchType(cypher);
      let edge = this.edges.find((e) => e.from === p.from && e.to === p.to && e.type === type);
      const created = !edge;
      if (!edge) {
        edge = { from: p.from as string, to: p.to as string, type, props: {} };
        edge.props._source = p.source;
        edge.props._manual_actor = p.actor;
        edge.props._confidence = p.confidence;
        edge.props._ingested_at = p.now;
        Object.assign(edge.props, (p.properties as Record<string, unknown>) ?? {});
        this.edges.push(edge);
      }
      const isManual = edge.props._manual_actor != null;
      const justCreated =
        created && edge.props._ingested_at === p.now && edge.props._manual_actor === p.actor;
      return {
        records: [
          {
            get: (k: string) => {
              if (k === 'isManual') return isManual;
              if (k === 'justCreated') return justCreated;
              return undefined;
            },
          },
        ],
      };
    }
    // Edge probe (count total + manual).
    if (cypher.includes('count(r) AS total')) {
      const type = matchType(cypher);
      const matches = this.edges.filter(
        (e) => e.from === p.from && e.to === p.to && e.type === type,
      );
      const manual = matches.filter((e) => e.props._manual_actor != null).length;
      return {
        records: [
          {
            get: (k: string) =>
              k === 'total' ? matches.length : k === 'manual' ? manual : undefined,
          },
        ],
      };
    }
    // Edge DELETE (manual only).
    if (cypher.includes('DELETE r')) {
      const type = matchType(cypher);
      this.edges = this.edges.filter(
        (e) =>
          !(e.from === p.from && e.to === p.to && e.type === type && e.props._manual_actor != null),
      );
      return { records: [] };
    }
    return { records: [] };
  }

  async runInWriteTransaction<T>(
    work: (tx: {
      run: (c: string, p?: Record<string, unknown>) => Promise<{ records: unknown[] }>;
    }) => Promise<T>,
  ): Promise<T> {
    return work({ run: async (c: string, p?: Record<string, unknown>) => this.run(c, p) });
  }
}

// Pull the relationship type out of an interpolated `:TYPE` fragment.
function matchType(cypher: string): string {
  const m = cypher.match(/\[r:([A-Za-z0-9_]+)\]/);
  return m ? m[1] : '';
}

// Live schema with the canonical OWNS relationship: Team -[OWNS]-> LogicalService.
const schemaStub = {
  getSchema: () => ({
    relationship_types: {
      OWNS: { from: 'Team', to: 'LogicalService', cardinality: '1:N' },
      DEPENDS_ON: { from: 'LogicalService', to: 'LogicalService', cardinality: 'N:M' },
    },
  }),
};

function makeService(fake: FakeNeo4j): RelationEditService {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new RelationEditService(fake as any, schemaStub as any);
}

const TEAM = 'shipit://team/default/platform';
const SVC = 'shipit://logicalservice/default/payments';
const SVC2 = 'shipit://logicalservice/default/billing';

describe('RelationEditService.addRelation', () => {
  let fake: FakeNeo4j;
  let service: RelationEditService;

  beforeEach(() => {
    fake = new FakeNeo4j();
    service = makeService(fake);
    fake.seedNode(TEAM, 'Team');
    fake.seedNode(SVC, 'LogicalService');
    fake.seedNode(SVC2, 'LogicalService');
  });

  it('creates a manual edge stamped with _manual_actor + provenance', async () => {
    const res = await service.addRelation({
      from: TEAM,
      to: SVC,
      type: 'OWNS',
      actor: 'alice@x',
    });
    expect(res).toEqual({ created: true });
    const edge = fake.edges.find((e) => e.type === 'OWNS')!;
    expect(edge.props._manual_actor).toBe('alice@x');
    expect(edge.props._source).toBe('manual:alice@x');
    expect(edge.props._confidence).toBe(MANUAL_RELIABILITY);
    expect(edge.props._ingested_at).toBeTruthy();
    // relation_added audit written.
    expect(fake.events.some((e) => e.kind === 'relation_added')).toBe(true);
    const ev = fake.events.find((e) => e.kind === 'relation_added')!;
    expect(ev).toMatchObject({ actor: 'alice@x', from: TEAM, to: SVC, type: 'OWNS' });
  });

  it('carries through caller-supplied edge properties', async () => {
    await service.addRelation({
      from: TEAM,
      to: SVC,
      type: 'OWNS',
      properties: { note: 'org chart' },
      actor: 'alice@x',
    });
    expect(fake.edges.find((e) => e.type === 'OWNS')!.props.note).toBe('org chart');
  });

  it('over an existing CONNECTOR edge is a no-op leaving provenance + props untouched', async () => {
    // A connector edge: _source github, _manual_actor ABSENT, has a property.
    fake.seedEdge({
      from: TEAM,
      to: SVC,
      type: 'OWNS',
      props: { _source: 'github', _confidence: 0.9, since: '2020' },
    });
    const res = await service.addRelation({
      from: TEAM,
      to: SVC,
      type: 'OWNS',
      properties: { since: 'HACKED' },
      actor: 'alice@x',
    });
    expect(res).toEqual({ created: false, preexistingConnectorEdge: true });
    const edge = fake.edges.find((e) => e.type === 'OWNS')!;
    // Connector provenance + properties are intact — NOT overwritten.
    expect(edge.props._source).toBe('github');
    expect(edge.props._manual_actor).toBeUndefined();
    expect(edge.props.since).toBe('2020');
    // No audit for a no-op.
    expect(fake.events.some((e) => e.kind === 'relation_added')).toBe(false);
  });

  it('over the actor own manual edge is an idempotent no-op (created:false)', async () => {
    await service.addRelation({ from: TEAM, to: SVC, type: 'OWNS', actor: 'alice@x' });
    fake.events.length = 0;
    const res = await service.addRelation({ from: TEAM, to: SVC, type: 'OWNS', actor: 'alice@x' });
    expect(res).toEqual({ created: false });
    expect(fake.edges.filter((e) => e.type === 'OWNS')).toHaveLength(1);
    expect(fake.events).toHaveLength(0);
  });

  it('rejects reserved underscore-prefixed property keys (provenance forgery) with INVALID_PROPERTIES (400) and writes no edge', async () => {
    // A graph:write caller must NOT be able to set internal `_`-prefixed keys —
    // doing so would forge `_manual_actor`/`_source` (disguise a manual edge as a
    // connector edge), corrupt `justCreated` via `_ingested_at`, or null out the
    // `_manual_actor` marker. The reserved-key guard rejects ALL such keys up
    // front, before any write. (This test FAILS pre-guard: the fake replicates the
    // vulnerable `Object.assign(props, properties)` LAST ordering.)
    await expect(
      service.addRelation({
        from: TEAM,
        to: SVC,
        type: 'OWNS',
        properties: { _manual_actor: 'attacker@x', _source: 'github', _ingested_at: 'x' },
        actor: 'alice@x',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROPERTIES' });
    expect(fake.edges).toHaveLength(0);
    expect(fake.events).toHaveLength(0);
  });

  it('rejects a single reserved key (_manual_actor:null) that would strip the marker', async () => {
    await expect(
      service.addRelation({
        from: TEAM,
        to: SVC,
        type: 'OWNS',
        properties: { _manual_actor: null },
        actor: 'alice@x',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROPERTIES' });
    expect(fake.edges).toHaveLength(0);
  });

  it('rejects an array property containing a null element with INVALID_PROPERTIES (400)', async () => {
    // A null list element would pass the old `value.every(isPrimitive)` check
    // (isPrimitive treats null as primitive) and then make Neo4j throw a
    // TypeError mid-transaction — the exact 500 this guard exists to prevent.
    await expect(
      service.addRelation({
        from: TEAM,
        to: SVC,
        type: 'OWNS',
        properties: { tags: ['a', null] },
        actor: 'alice@x',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROPERTIES' });
    expect(fake.edges).toHaveLength(0);
  });

  it('a normal create still stamps provenance, writes a relation_added audit, returns created:true', async () => {
    const res = await service.addRelation({
      from: TEAM,
      to: SVC,
      type: 'OWNS',
      properties: { note: 'legit' },
      actor: 'alice@x',
    });
    expect(res).toEqual({ created: true });
    const edge = fake.edges.find((e) => e.type === 'OWNS')!;
    expect(edge.props._manual_actor).toBe('alice@x');
    expect(edge.props._source).toBe('manual:alice@x');
    expect(edge.props.note).toBe('legit');
    expect(fake.events.filter((e) => e.kind === 'relation_added')).toHaveLength(1);
  });

  it('rejects a type not in the schema with INVALID_RELATION_TYPE (400)', async () => {
    await expect(
      service.addRelation({ from: TEAM, to: SVC, type: 'NOT_A_TYPE', actor: 'alice@x' }),
    ).rejects.toBeInstanceOf(RelationEditValidationError);
    await expect(
      service.addRelation({ from: TEAM, to: SVC, type: 'NOT_A_TYPE', actor: 'alice@x' }),
    ).rejects.toMatchObject({ code: 'INVALID_RELATION_TYPE' });
    expect(fake.edges).toHaveLength(0);
  });

  it('rejects an injection-y raw type that SANITIZES to an allow-listed type (validated pre-sanitize)', async () => {
    // `OWNS]->(x)//` sanitizes to `OWNS_x___` (mangled) — but the RAW value is
    // not a schema key, so it is rejected BEFORE sanitize ever runs. Crucially,
    // we never sanitize-then-accept.
    await expect(
      service.addRelation({ from: TEAM, to: SVC, type: 'OWNS]->(x)//', actor: 'alice@x' }),
    ).rejects.toMatchObject({ code: 'INVALID_RELATION_TYPE' });
    expect(fake.edges).toHaveLength(0);
  });

  it('rejects a self-loop with SELF_LOOP (400)', async () => {
    await expect(
      service.addRelation({ from: SVC, to: SVC, type: 'DEPENDS_ON', actor: 'alice@x' }),
    ).rejects.toMatchObject({ code: 'SELF_LOOP' });
    expect(fake.edges).toHaveLength(0);
  });

  it('rejects a missing FROM endpoint with ENDPOINT_NOT_FOUND (404)', async () => {
    await expect(
      service.addRelation({ from: 'shipit://nope', to: SVC, type: 'OWNS', actor: 'alice@x' }),
    ).rejects.toBeInstanceOf(RelationEditNotFoundError);
  });

  it('rejects a missing TO endpoint with ENDPOINT_NOT_FOUND (404)', async () => {
    await expect(
      service.addRelation({ from: TEAM, to: 'shipit://nope', type: 'OWNS', actor: 'alice@x' }),
    ).rejects.toMatchObject({ code: 'ENDPOINT_NOT_FOUND' });
  });

  it('rejects a from/to endpoint whose label violates the schema constraint (400)', async () => {
    // OWNS requires from=Team; a LogicalService from-node violates it.
    await expect(
      service.addRelation({ from: SVC2, to: SVC, type: 'OWNS', actor: 'alice@x' }),
    ).rejects.toMatchObject({ code: 'ENDPOINT_LABEL_MISMATCH' });
    expect(fake.edges).toHaveLength(0);
  });
});

describe('RelationEditService.deleteRelation', () => {
  let fake: FakeNeo4j;
  let service: RelationEditService;

  beforeEach(() => {
    fake = new FakeNeo4j();
    service = makeService(fake);
    fake.seedNode(TEAM, 'Team');
    fake.seedNode(SVC, 'LogicalService');
  });

  it('removes a manual edge and writes a relation_removed audit', async () => {
    fake.seedEdge({ from: TEAM, to: SVC, type: 'OWNS', props: { _manual_actor: 'alice@x' } });
    const deleted = await service.deleteRelation({
      from: TEAM,
      to: SVC,
      type: 'OWNS',
      actor: 'alice@x',
    });
    expect(deleted).toBe(true);
    expect(fake.edges.filter((e) => e.type === 'OWNS')).toHaveLength(0);
    expect(fake.events.some((e) => e.kind === 'relation_removed')).toBe(true);
    const ev = fake.events.find((e) => e.kind === 'relation_removed')!;
    expect(ev).toMatchObject({ actor: 'alice@x', from: TEAM, to: SVC, type: 'OWNS' });
  });

  it('refuses to delete a CONNECTOR edge with CONNECTOR_EDGE (409)', async () => {
    fake.seedEdge({ from: TEAM, to: SVC, type: 'OWNS', props: { _source: 'github' } });
    await expect(
      service.deleteRelation({ from: TEAM, to: SVC, type: 'OWNS', actor: 'alice@x' }),
    ).rejects.toBeInstanceOf(RelationEditConflictError);
    // Connector edge survives; no audit.
    expect(fake.edges.filter((e) => e.type === 'OWNS')).toHaveLength(1);
    expect(fake.events).toHaveLength(0);
  });

  it('is idempotent (returns false) when no edge matches', async () => {
    const deleted = await service.deleteRelation({
      from: TEAM,
      to: SVC,
      type: 'OWNS',
      actor: 'alice@x',
    });
    expect(deleted).toBe(false);
    expect(fake.events).toHaveLength(0);
  });

  it('validates the type before interpolating (unknown type → 400)', async () => {
    await expect(
      service.deleteRelation({ from: TEAM, to: SVC, type: 'NOPE', actor: 'alice@x' }),
    ).rejects.toMatchObject({ code: 'INVALID_RELATION_TYPE' });
  });
});
