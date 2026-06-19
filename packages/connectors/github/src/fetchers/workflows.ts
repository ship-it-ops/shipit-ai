import type { Octokit } from '@octokit/rest';
import type { FetchResult } from '@shipit-ai/connector-sdk';

export interface GitHubWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
  html_url: string;
  repo_name: string;
  repo_full_name: string;
  // Workflow definition's last-modified time — a fallback freshness signal for
  // `_event_version` when there are no recent runs. Nullable.
  updated_at: string | null;
  recent_runs: GitHubWorkflowRun[];
}

export interface GitHubWorkflowRun {
  id: number;
  status: string | null;
  conclusion: string | null;
  created_at: string;
}

export async function fetchWorkflows(
  octokit: Octokit,
  org: string,
  repos: string[],
  cursor?: string,
): Promise<FetchResult> {
  // Cursor format: "repoIndex:page" or just page for first repo
  const startIndex = cursor ? Number(cursor) : 0;
  const entities: GitHubWorkflow[] = [];

  // Fetch workflows for repos starting from the cursor index
  const endIndex = Math.min(startIndex + 10, repos.length); // batch 10 repos at a time

  for (let i = startIndex; i < endIndex; i++) {
    const repoName = repos[i];
    try {
      const { data } = await octokit.rest.actions.listRepoWorkflows({
        owner: org,
        repo: repoName,
        per_page: 100,
      });

      for (const wf of data.workflows) {
        // Fetch recent runs for each workflow
        let recentRuns: GitHubWorkflowRun[] = [];
        try {
          const { data: runs } = await octokit.rest.actions.listWorkflowRuns({
            owner: org,
            repo: repoName,
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
          // Skip run fetch failures
        }

        entities.push({
          id: wf.id,
          name: wf.name,
          path: wf.path,
          state: wf.state,
          html_url: wf.html_url,
          repo_name: repoName,
          repo_full_name: `${org}/${repoName}`,
          updated_at: wf.updated_at ?? null,
          recent_runs: recentRuns,
        });
      }
    } catch {
      // Skip repos where we can't fetch workflows
    }
  }

  return {
    entities,
    cursor: endIndex < repos.length ? String(endIndex) : undefined,
    has_more: endIndex < repos.length,
  };
}
