import { describe, it, expect } from 'vitest';
import { buildCanonicalId, buildScopedCanonicalId, buildLinkingKey } from '@shipit-ai/shared';
import { normalizeRepository } from '../normalizers/repository.js';
import { normalizeTeam } from '../normalizers/team.js';
import { normalizePipeline } from '../normalizers/pipeline.js';
import { normalizeCodeowner } from '../normalizers/codeowner.js';
import type { GitHubRepo } from '../fetchers/repositories.js';
import type { GitHubTeam } from '../fetchers/teams.js';
import type { GitHubWorkflow } from '../fetchers/workflows.js';
import type { CodeownersEntry } from '../fetchers/codeowners.js';

const ORG = 'shipitops';

describe('normalizeRepository', () => {
  const mockRepo: GitHubRepo = {
    name: 'graph-api',
    full_name: 'shipitops/graph-api',
    html_url: 'https://github.com/shipitops/graph-api',
    default_branch: 'main',
    visibility: 'private',
    language: 'TypeScript',
    topics: ['backend', 'payments'],
    archived: false,
    description: 'Payment processing API',
  };

  it('produces a CanonicalNode with label=Repository', () => {
    const result = normalizeRepository(mockRepo, ORG);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].label).toBe('Repository');
  });

  it('sets correct canonical ID with org scope', () => {
    const result = normalizeRepository(mockRepo, ORG);
    expect(result.nodes[0].id).toBe(
      buildScopedCanonicalId('Repository', 'default', ORG, 'graph-api'),
    );
  });

  it('sets correct _source_id as linking key', () => {
    const result = normalizeRepository(mockRepo, ORG);
    expect(result.nodes[0]._source_id).toBe(buildLinkingKey('github', ORG, 'graph-api'));
  });

  it('creates claims for name, url, default_branch, visibility, language, topics', () => {
    const result = normalizeRepository(mockRepo, ORG);
    const claims = result.nodes[0]._claims;

    const claimKeys = claims.map((c) => c.property_key);
    expect(claimKeys).toContain('name');
    expect(claimKeys).toContain('url');
    expect(claimKeys).toContain('default_branch');
    expect(claimKeys).toContain('visibility');
    expect(claimKeys).toContain('language');
    expect(claimKeys).toContain('topics');
  });

  it('sets source=github and confidence=0.9 on all claims', () => {
    const result = normalizeRepository(mockRepo, ORG);
    for (const claim of result.nodes[0]._claims) {
      expect(claim.source).toBe('github');
      expect(claim.confidence).toBe(0.9);
    }
  });

  it('sets _source_system to github', () => {
    const result = normalizeRepository(mockRepo, ORG);
    expect(result.nodes[0]._source_system).toBe('github');
  });

  it('produces no edges', () => {
    const result = normalizeRepository(mockRepo, ORG);
    expect(result.edges).toHaveLength(0);
  });
});

describe('normalizeTeam', () => {
  const mockTeam: GitHubTeam = {
    slug: 'platform',
    name: 'Platform Team',
    description: 'Platform engineering team',
    privacy: 'closed',
    html_url: 'https://github.com/orgs/shipitops/teams/platform',
    members: [
      {
        login: 'alice',
        avatar_url: 'https://avatars.githubusercontent.com/alice',
        html_url: 'https://github.com/alice',
        role: 'member',
      },
      {
        login: 'bob',
        avatar_url: 'https://avatars.githubusercontent.com/bob',
        html_url: 'https://github.com/bob',
        role: 'maintainer',
      },
    ],
  };

  it('produces Team node + Person nodes', () => {
    const result = normalizeTeam(mockTeam, ORG);
    expect(result.nodes).toHaveLength(3); // 1 Team + 2 Person
    expect(result.nodes[0].label).toBe('Team');
    expect(result.nodes[1].label).toBe('Person');
    expect(result.nodes[2].label).toBe('Person');
  });

  it('sets correct canonical IDs (Team scoped by org, Person global)', () => {
    const result = normalizeTeam(mockTeam, ORG);
    expect(result.nodes[0].id).toBe(buildScopedCanonicalId('Team', 'default', ORG, 'platform'));
    expect(result.nodes[1].id).toBe(buildCanonicalId('Person', 'default', 'alice'));
  });

  it('produces MEMBER_OF edges from Person to Team', () => {
    const result = normalizeTeam(mockTeam, ORG);
    expect(result.edges).toHaveLength(2);

    for (const edge of result.edges) {
      expect(edge.type).toBe('MEMBER_OF');
      expect(edge.to).toBe(buildScopedCanonicalId('Team', 'default', ORG, 'platform'));
      expect(edge._source).toBe('github');
      expect(edge._confidence).toBe(0.9);
    }
  });

  it('sets claims on Team node', () => {
    const result = normalizeTeam(mockTeam, ORG);
    const teamClaims = result.nodes[0]._claims;
    const claimKeys = teamClaims.map((c) => c.property_key);
    expect(claimKeys).toContain('name');
    expect(claimKeys).toContain('slug');
  });
});

describe('normalizePipeline', () => {
  const mockWorkflow: GitHubWorkflow = {
    id: 12345,
    name: 'CI',
    path: '.github/workflows/ci.yml',
    state: 'active',
    html_url: 'https://github.com/shipitops/graph-api/actions/workflows/ci.yml',
    repo_name: 'graph-api',
    repo_full_name: 'shipitops/graph-api',
    recent_runs: [
      {
        id: 1,
        status: 'completed',
        conclusion: 'success',
        created_at: '2026-02-28T10:00:00Z',
      },
    ],
  };

  it('produces Pipeline node', () => {
    const result = normalizePipeline(mockWorkflow, ORG);
    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].label).toBe('Pipeline');
  });

  it('produces BUILT_BY edge from Repository to Pipeline', () => {
    const result = normalizePipeline(mockWorkflow, ORG);
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].type).toBe('BUILT_BY');
    expect(result.edges[0].from).toBe(
      buildScopedCanonicalId('Repository', 'default', ORG, 'graph-api'),
    );
    expect(result.edges[0].to).toBe(result.nodes[0].id);
  });

  it('includes last run info in properties', () => {
    const result = normalizePipeline(mockWorkflow, ORG);
    const props = result.nodes[0].properties;
    expect(props['last_run_status']).toBe('completed');
    expect(props['last_run_conclusion']).toBe('success');
  });
});

describe('normalizeCodeowner', () => {
  const mockEntry: CodeownersEntry = {
    pattern: '*.ts',
    owners: ['@shipitops/platform', '@alice'],
    repo_name: 'graph-api',
    repo_full_name: 'shipitops/graph-api',
  };

  it('produces CODEOWNER_OF edges', () => {
    const result = normalizeCodeowner(mockEntry, ORG);
    expect(result.edges).toHaveLength(2);
    expect(result.nodes).toHaveLength(0);
  });

  it('resolves team owners to Team canonical IDs preserving the @org/team org', () => {
    const result = normalizeCodeowner(mockEntry, ORG);
    const teamEdge = result.edges.find((e) => e.from.includes('team'));
    expect(teamEdge).toBeDefined();
    expect(teamEdge!.from).toBe(buildScopedCanonicalId('Team', 'default', 'shipitops', 'platform'));
    expect(teamEdge!.type).toBe('CODEOWNER_OF');
  });

  it('routes CODEOWNER_OF edges to the org-scoped Repository ID', () => {
    const result = normalizeCodeowner(mockEntry, ORG);
    for (const edge of result.edges) {
      expect(edge.to).toBe(buildScopedCanonicalId('Repository', 'default', ORG, 'graph-api'));
    }
  });

  it('resolves user owners to Person canonical IDs (global, unscoped)', () => {
    const result = normalizeCodeowner(mockEntry, ORG);
    const personEdge = result.edges.find((e) => e.from.includes('person'));
    expect(personEdge).toBeDefined();
    expect(personEdge!.from).toBe(buildCanonicalId('Person', 'default', 'alice'));
  });

  it('includes pattern in edge properties', () => {
    const result = normalizeCodeowner(mockEntry, ORG);
    for (const edge of result.edges) {
      expect(edge.properties?.['pattern']).toBe('*.ts');
    }
  });

  it('sets confidence to 0.95', () => {
    const result = normalizeCodeowner(mockEntry, ORG);
    for (const edge of result.edges) {
      expect(edge._confidence).toBe(0.95);
    }
  });
});
