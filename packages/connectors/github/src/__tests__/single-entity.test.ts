import { describe, it, expect, vi } from 'vitest';
import type { Octokit } from '@octokit/rest';
import {
  fetchRepository,
  fetchRepositoryWorkflows,
  fetchRepositoryCodeowners,
} from '../fetchers/single-entity.js';
import { normalizeRepository } from '../normalizers/repository.js';
import { normalizePipeline } from '../normalizers/pipeline.js';
import { normalizeCodeowner } from '../normalizers/codeowner.js';

/**
 * Builds a minimal Octokit stub. Only the REST methods the fetcher under test
 * calls need to be present; everything else is cast away.
 */
function stubOctokit(rest: Record<string, unknown>): Octokit {
  return { rest } as unknown as Octokit;
}

const OWNER = 'test-org';
const REPO = 'my-repo';

describe('fetchRepository', () => {
  it('returns a single GitHubRepo-shaped object that satisfies normalize discriminators', async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        name: 'my-repo',
        full_name: 'test-org/my-repo',
        html_url: 'https://github.com/test-org/my-repo',
        default_branch: 'main',
        visibility: 'private',
        language: 'TypeScript',
        topics: ['platform'],
        archived: false,
        description: 'A repo',
      },
    });
    const octokit = stubOctokit({ repos: { get } });

    const repo = await fetchRepository(octokit, OWNER, REPO);

    expect(get).toHaveBeenCalledWith({ owner: OWNER, repo: REPO });
    // The connector.normalize() dispatch routes on `full_name` + `default_branch`.
    expect(repo.full_name).toBe('test-org/my-repo');
    expect(repo.default_branch).toBe('main');
    expect(repo).toEqual({
      name: 'my-repo',
      full_name: 'test-org/my-repo',
      html_url: 'https://github.com/test-org/my-repo',
      default_branch: 'main',
      visibility: 'private',
      language: 'TypeScript',
      topics: ['platform'],
      archived: false,
      description: 'A repo',
    });
  });

  it('applies the same defaults as fetchRepositories for nullable fields', async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        name: 'my-repo',
        full_name: 'test-org/my-repo',
        html_url: 'https://github.com/test-org/my-repo',
        default_branch: null,
        visibility: null,
        language: null,
        topics: undefined,
        archived: undefined,
        description: null,
      },
    });
    const octokit = stubOctokit({ repos: { get } });

    const repo = await fetchRepository(octokit, OWNER, REPO);

    expect(repo.default_branch).toBe('main');
    expect(repo.visibility).toBe('private');
    expect(repo.language).toBeNull();
    expect(repo.topics).toEqual([]);
    expect(repo.archived).toBe(false);
  });

  it('flows through normalizeRepository without error', async () => {
    const get = vi.fn().mockResolvedValue({
      data: {
        name: 'my-repo',
        full_name: 'test-org/my-repo',
        html_url: 'https://github.com/test-org/my-repo',
        default_branch: 'main',
        visibility: 'public',
        language: 'Go',
        topics: [],
        archived: false,
        description: null,
      },
    });
    const octokit = stubOctokit({ repos: { get } });

    const repo = await fetchRepository(octokit, OWNER, REPO);
    const result = normalizeRepository(repo, OWNER);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].label).toBe('Repository');
    expect(result.nodes[0].properties.name).toBe('my-repo');
  });
});

describe('fetchRepositoryWorkflows', () => {
  it('returns GitHubWorkflow-shaped objects that satisfy normalize discriminators', async () => {
    const listRepoWorkflows = vi.fn().mockResolvedValue({
      data: {
        workflows: [
          {
            id: 101,
            name: 'CI',
            path: '.github/workflows/ci.yml',
            state: 'active',
            html_url: 'https://github.com/test-org/my-repo/actions/workflows/ci.yml',
          },
        ],
      },
    });
    const listWorkflowRuns = vi.fn().mockResolvedValue({
      data: {
        workflow_runs: [
          {
            id: 9001,
            status: 'completed',
            conclusion: 'success',
            created_at: '2026-06-18T00:00:00Z',
          },
        ],
      },
    });
    const octokit = stubOctokit({ actions: { listRepoWorkflows, listWorkflowRuns } });

    const workflows = await fetchRepositoryWorkflows(octokit, OWNER, REPO);

    expect(listRepoWorkflows).toHaveBeenCalledWith({ owner: OWNER, repo: REPO, per_page: 100 });
    expect(listWorkflowRuns).toHaveBeenCalledWith({
      owner: OWNER,
      repo: REPO,
      workflow_id: 101,
      per_page: 5,
    });
    expect(workflows).toHaveLength(1);
    const wf = workflows[0];
    // connector.normalize() routes workflows on `path` + `repo_name` + `state`.
    expect(wf.path).toBe('.github/workflows/ci.yml');
    expect(wf.repo_name).toBe(REPO);
    expect(wf.state).toBe('active');
    expect(wf.repo_full_name).toBe('test-org/my-repo');
    expect(wf.recent_runs).toEqual([
      { id: 9001, status: 'completed', conclusion: 'success', created_at: '2026-06-18T00:00:00Z' },
    ]);
  });

  it('tolerates run-fetch failures and still returns the workflow', async () => {
    const listRepoWorkflows = vi.fn().mockResolvedValue({
      data: {
        workflows: [
          {
            id: 1,
            name: 'CI',
            path: '.github/workflows/ci.yml',
            state: 'active',
            html_url: 'https://github.com/test-org/my-repo/actions/workflows/ci.yml',
          },
        ],
      },
    });
    const listWorkflowRuns = vi.fn().mockRejectedValue(new Error('403'));
    const octokit = stubOctokit({ actions: { listRepoWorkflows, listWorkflowRuns } });

    const workflows = await fetchRepositoryWorkflows(octokit, OWNER, REPO);

    expect(workflows).toHaveLength(1);
    expect(workflows[0].recent_runs).toEqual([]);
  });

  it('flows through normalizePipeline without error', async () => {
    const listRepoWorkflows = vi.fn().mockResolvedValue({
      data: {
        workflows: [
          {
            id: 101,
            name: 'CI',
            path: '.github/workflows/ci.yml',
            state: 'active',
            html_url: 'https://github.com/test-org/my-repo/actions/workflows/ci.yml',
          },
        ],
      },
    });
    const listWorkflowRuns = vi.fn().mockResolvedValue({
      data: {
        workflow_runs: [
          {
            id: 9001,
            status: 'completed',
            conclusion: 'success',
            created_at: '2026-06-18T00:00:00Z',
          },
        ],
      },
    });
    const octokit = stubOctokit({ actions: { listRepoWorkflows, listWorkflowRuns } });

    const workflows = await fetchRepositoryWorkflows(octokit, OWNER, REPO);
    const result = normalizePipeline(workflows[0], OWNER);

    expect(result.nodes).toHaveLength(1);
    expect(result.nodes[0].label).toBe('Pipeline');
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].type).toBe('BUILT_BY');
  });
});

describe('fetchRepositoryCodeowners', () => {
  it('returns CodeownersEntry-shaped objects that satisfy normalize discriminators', async () => {
    const content = Buffer.from('*.ts @test-org/frontend @alice\n', 'utf-8').toString('base64');
    const getContent = vi.fn().mockResolvedValue({ data: { content } });
    const octokit = stubOctokit({ repos: { getContent } });

    const entries = await fetchRepositoryCodeowners(octokit, OWNER, REPO);

    expect(entries).toHaveLength(1);
    const entry = entries[0];
    // connector.normalize() routes codeowners on `pattern` + `owners`.
    expect(entry.pattern).toBe('*.ts');
    expect(entry.owners).toEqual(['@test-org/frontend', '@alice']);
    expect(entry.repo_name).toBe(REPO);
    expect(entry.repo_full_name).toBe('test-org/my-repo');
  });

  it('returns an empty array when no CODEOWNERS file exists', async () => {
    const getContent = vi.fn().mockRejectedValue(new Error('404'));
    const octokit = stubOctokit({ repos: { getContent } });

    const entries = await fetchRepositoryCodeowners(octokit, OWNER, REPO);

    expect(entries).toEqual([]);
  });

  it('flows through normalizeCodeowner without error', async () => {
    const content = Buffer.from('*.ts @test-org/frontend @alice\n', 'utf-8').toString('base64');
    const getContent = vi.fn().mockResolvedValue({ data: { content } });
    const octokit = stubOctokit({ repos: { getContent } });

    const entries = await fetchRepositoryCodeowners(octokit, OWNER, REPO);
    const result = normalizeCodeowner(entries[0], OWNER);

    expect(result.edges).toHaveLength(2);
    expect(result.edges[0].type).toBe('CODEOWNER_OF');
  });
});
