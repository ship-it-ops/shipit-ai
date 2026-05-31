import { describe, it, expect } from 'vitest';
import { DEFAULT_OWNERSHIP_REL_TYPES } from '@shipit-ai/shared';
import type { GraphData } from '@/lib/api';
import { buildOwnershipIndex } from './ownership-index';

const teamId = 'Team::default::shipitops/platform';
const personId = 'Person::default::mohamed';
const repoId = 'Repository::default::shipitops/web';
const svcId = 'shipit://LogicalService/default/billing';

describe('buildOwnershipIndex', () => {
  it('returns an empty map for missing data', () => {
    const idx = buildOwnershipIndex(undefined, DEFAULT_OWNERSHIP_REL_TYPES);
    expect(idx.size).toBe(0);
  });

  it('records CODEOWNER_OF edge sources as owners of the target Repository', () => {
    const data: GraphData = {
      nodes: [
        { data: { id: teamId, name: 'platform-team', label: 'platform-team', type: 'Team' } },
        { data: { id: repoId, name: 'web', label: 'web', type: 'Repository' } },
      ],
      edges: [{ data: { id: 'e1', source: teamId, target: repoId, type: 'CODEOWNER_OF' } }],
    };
    const idx = buildOwnershipIndex(data, DEFAULT_OWNERSHIP_REL_TYPES);
    expect(idx.get(repoId)?.has('platform-team')).toBe(true);
  });

  it('records OWNS edges as ownership of the target service', () => {
    const data: GraphData = {
      nodes: [
        { data: { id: teamId, name: 'platform-team', label: 'platform-team', type: 'Team' } },
        { data: { id: svcId, name: 'billing', label: 'billing', type: 'LogicalService' } },
      ],
      edges: [{ data: { id: 'e1', source: teamId, target: svcId, type: 'OWNS' } }],
    };
    const idx = buildOwnershipIndex(data, DEFAULT_OWNERSHIP_REL_TYPES);
    expect(idx.get(svcId)?.has('platform-team')).toBe(true);
  });

  // Regression guard: MEMBER_OF must not be treated as ownership. Person is
  // member-of Team — that doesn't mean Team is owned by Person.
  it('does NOT treat MEMBER_OF as ownership (membership ≠ ownership)', () => {
    const data: GraphData = {
      nodes: [
        { data: { id: personId, name: 'mohamed', label: 'mohamed', type: 'Person' } },
        { data: { id: teamId, name: 'platform-team', label: 'platform-team', type: 'Team' } },
      ],
      edges: [{ data: { id: 'e1', source: personId, target: teamId, type: 'MEMBER_OF' } }],
    };
    const idx = buildOwnershipIndex(data, DEFAULT_OWNERSHIP_REL_TYPES);
    // Team's ownership set is just itself (Team owns itself for self-filtering).
    // Critically, it must NOT contain the member Person's name.
    expect(idx.get(teamId)?.has('platform-team')).toBe(true);
    expect(idx.get(teamId)?.has('mohamed')).toBe(false);
  });

  it('honors `d.owner` string property for seeded LogicalServices', () => {
    const data: GraphData = {
      nodes: [
        {
          data: {
            id: svcId,
            name: 'billing',
            label: 'billing',
            type: 'LogicalService',
            owner: 'api-team',
          },
        },
      ],
      edges: [],
    };
    const idx = buildOwnershipIndex(data, DEFAULT_OWNERSHIP_REL_TYPES);
    expect(idx.get(svcId)?.has('api-team')).toBe(true);
  });

  it('treats Team and Person nodes as owners of themselves', () => {
    const data: GraphData = {
      nodes: [
        { data: { id: teamId, name: 'platform-team', label: 'platform-team', type: 'Team' } },
        { data: { id: personId, name: 'mohamed', label: 'mohamed', type: 'Person' } },
      ],
      edges: [],
    };
    const idx = buildOwnershipIndex(data, DEFAULT_OWNERSHIP_REL_TYPES);
    expect(idx.get(teamId)?.has('platform-team')).toBe(true);
    expect(idx.get(personId)?.has('mohamed')).toBe(true);
  });

  it('skips edges whose source node id is missing from the payload', () => {
    const data: GraphData = {
      nodes: [{ data: { id: repoId, name: 'web', label: 'web', type: 'Repository' } }],
      edges: [
        {
          data: { id: 'e1', source: 'Team::default::ghost', target: repoId, type: 'CODEOWNER_OF' },
        },
      ],
    };
    const idx = buildOwnershipIndex(data, DEFAULT_OWNERSHIP_REL_TYPES);
    expect(idx.has(repoId)).toBe(false);
  });

  it('honors custom ownership rel types (extensibility for future connectors)', () => {
    const data: GraphData = {
      nodes: [
        { data: { id: teamId, name: 'platform-team', label: 'platform-team', type: 'Team' } },
        { data: { id: svcId, name: 'billing', label: 'billing', type: 'LogicalService' } },
      ],
      edges: [{ data: { id: 'e1', source: teamId, target: svcId, type: 'MAINTAINS' } }],
    };
    const idx = buildOwnershipIndex(data, new Set(['MAINTAINS']));
    expect(idx.get(svcId)?.has('platform-team')).toBe(true);
  });

  it('ignores edges whose type is not in the ownership set', () => {
    const data: GraphData = {
      nodes: [
        { data: { id: teamId, name: 'platform-team', label: 'platform-team', type: 'Team' } },
        { data: { id: svcId, name: 'billing', label: 'billing', type: 'LogicalService' } },
      ],
      edges: [{ data: { id: 'e1', source: teamId, target: svcId, type: 'DEPENDS_ON' } }],
    };
    const idx = buildOwnershipIndex(data, DEFAULT_OWNERSHIP_REL_TYPES);
    // svc has no owner — DEPENDS_ON is not ownership.
    expect(idx.has(svcId)).toBe(false);
  });
});
