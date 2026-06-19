import type { Octokit } from '@octokit/rest';
import type { GitHubRepo } from './repositories.js';
import type { GitHubWorkflow, GitHubWorkflowRun } from './workflows.js';
import type { CodeownersEntry } from './codeowners.js';
import { fetchCodeownersFile, parseCodeowners } from './codeowners.js';

/**
 * Fetch a single repository and project it into the same `GitHubRepo` shape
 * that one element of `fetchRepositories`' output uses, so it can be passed
 * straight to the connector's `normalize` / `normalizeRepository` path.
 *
 * Codeowners are a separate entity type in this connector (fetched by
 * `fetchCodeowners`, not bundled into the repo fetch), so they are NOT
 * returned here — use `fetchRepositoryCodeowners` to mirror that path for a
 * single repo (e.g. a `push` webhook → repo + codeowners refetch).
 */
export async function fetchRepository(
  octokit: Octokit,
  owner: string,
  name: string,
): Promise<GitHubRepo> {
  const { data: repo } = await octokit.rest.repos.get({ owner, repo: name });

  return {
    name: repo.name,
    full_name: repo.full_name,
    html_url: repo.html_url,
    default_branch: repo.default_branch ?? 'main',
    visibility: repo.visibility ?? 'private',
    language: repo.language ?? null,
    topics: repo.topics ?? [],
    archived: repo.archived ?? false,
    description: repo.description ?? null,
    updated_at: repo.updated_at ?? null,
    pushed_at: repo.pushed_at ?? null,
  };
}

/**
 * Fetch the workflows (and their recent runs) for a single repository,
 * projected into the same `GitHubWorkflow` shape that `fetchWorkflows`
 * produces per repo, so each element flows through `normalizePipeline`.
 */
export async function fetchRepositoryWorkflows(
  octokit: Octokit,
  owner: string,
  name: string,
): Promise<GitHubWorkflow[]> {
  const { data } = await octokit.rest.actions.listRepoWorkflows({
    owner,
    repo: name,
    per_page: 100,
  });

  const entities: GitHubWorkflow[] = [];

  for (const wf of data.workflows) {
    let recentRuns: GitHubWorkflowRun[] = [];
    try {
      const { data: runs } = await octokit.rest.actions.listWorkflowRuns({
        owner,
        repo: name,
        workflow_id: wf.id,
        per_page: 5,
      });
      recentRuns = runs.workflow_runs.map((run) => ({
        id: run.id,
        status: run.status,
        conclusion: run.conclusion,
        created_at: run.created_at,
      }));
    } catch {
      // Skip run fetch failures, mirroring fetchWorkflows.
    }

    entities.push({
      id: wf.id,
      name: wf.name,
      path: wf.path,
      state: wf.state,
      html_url: wf.html_url,
      repo_name: name,
      repo_full_name: `${owner}/${name}`,
      updated_at: wf.updated_at ?? null,
      recent_runs: recentRuns,
    });
  }

  return entities;
}

/**
 * Fetch the CODEOWNERS entries for a single repository, projected into the
 * same `CodeownersEntry` shape that `fetchCodeowners` produces, so each
 * element flows through `normalizeCodeowner`. Mirrors the separate codeowners
 * fetch path (a `push` webhook refetches repo + codeowners together).
 */
export async function fetchRepositoryCodeowners(
  octokit: Octokit,
  owner: string,
  name: string,
): Promise<CodeownersEntry[]> {
  const content = await fetchCodeownersFile(octokit, owner, name);
  if (!content) return [];
  return parseCodeowners(content, name, owner);
}
