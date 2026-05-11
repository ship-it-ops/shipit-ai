import { describe, it, expect } from 'vitest';
import { buildCanonicalId, buildLinkingKey } from '@shipit-ai/shared';
import { normalizeRepository } from '../normalizers/repository.js';
import { normalizeTeam } from '../normalizers/team.js';
import { normalizePipeline } from '../normalizers/pipeline.js';
import { normalizeCodeowner } from '../normalizers/codeowner.js';
import type { GitHubRepo } from '../fetchers/repositories.js';
import type { GitHubTeam } from '../fetchers/teams.js';
import type { GitHubWorkflow } from '../fetchers/workflows.js';
import type { CodeownersEntry } from '../fetchers/codeowners.js';

const ORG = 'acme-corp';

describe('normalizeRepository', () => {
  const mockRepo: GitHubRepo = {
    name: 'payments-api',
    full_name: 'acme-corp/payments-api',
    html_url: 'https://github.com/acme-corp/payments-api',
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

  it('sets correct canonical ID', () => {
    const result = normalizeRepository(mockRepo, ORG);
    expect(result.nodes[0].id).toBe(buildCanonicalId('Repository', 'default', 'payments-api'));
  });

  it('sets correct _source_id as linking key', () => {
    const result = normalizeRepository(mockRepo, ORG);
    expect(result.nodes[0]._source_id).toBe(buildLinkingKey('github', ORG, 'payments-api'));
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
    html_url: 'https://github.com/orgs/acme-corp/teams/platform',
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

  it('sets correct canonical IDs', () => {
    const result = normalizeTeam(mockTeam, ORG);
    expect(result.nodes[0].id).toBe(buildCanonicalId('Team', 'default', 'platform'));
    expect(result.nodes[1].id).toBe(buildCanonicalId('Person', 'default', 'alice'));
  });

  it('produces MEMBER_OF edges from Person to Team', () => {
    const result = normalizeTeam(mockTeam, ORG);
    expect(result.edges).toHaveLength(2);

    for (const edge of result.edges) {
      expect(edge.type).toBe('MEMBER_OF');
      expect(edge.to).toBe(buildCanonicalId('Team', 'default', 'platform'));
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
    html_url: 'https://github.com/acme-corp/payments-api/actions/workflows/ci.yml',
    repo_name: 'payments-api',
    repo_full_name: 'acme-corp/payments-api',
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
    expect(result.edges[0].from).toBe(buildCanonicalId('Repository', 'default', 'payments-api'));
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
    owners: ['@acme-corp/platform', '@alice'],
    repo_name: 'payments-api',
    repo_full_name: 'acme-corp/payments-api',
  };

  it('produces CODEOWNER_OF edges', () => {
    const result = normalizeCodeowner(mockEntry);
    expect(result.edges).toHaveLength(2);
    expect(result.nodes).toHaveLength(0);
  });

  it('resolves team owners to Team canonical IDs', () => {
    const result = normalizeCodeowner(mockEntry);
    const teamEdge = result.edges.find((e) => e.from.includes('team'));
    expect(teamEdge).toBeDefined();
    expect(teamEdge!.from).toBe(buildCanonicalId('Team', 'default', 'platform'));
    expect(teamEdge!.type).toBe('CODEOWNER_OF');
  });

  it('resolves user owners to Person canonical IDs', () => {
    const result = normalizeCodeowner(mockEntry);
    const personEdge = result.edges.find((e) => e.from.includes('person'));
    expect(personEdge).toBeDefined();
    expect(personEdge!.from).toBe(buildCanonicalId('Person', 'default', 'alice'));
  });

  it('includes pattern in edge properties', () => {
    const result = normalizeCodeowner(mockEntry);
    for (const edge of result.edges) {
      expect(edge.properties?.['pattern']).toBe('*.ts');
    }
  });

  it('sets confidence to 0.95', () => {
    const result = normalizeCodeowner(mockEntry);
    for (const edge of result.edges) {
      expect(edge._confidence).toBe(0.95);
    }
  });
});
