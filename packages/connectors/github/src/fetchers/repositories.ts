import type { Octokit } from '@octokit/rest';
import type { FetchResult } from '@shipit-ai/connector-sdk';

export interface GitHubRepo {
  name: string;
  full_name: string;
  html_url: string;
  default_branch: string;
  visibility: string;
  language: string | null;
  topics: string[];
  archived: boolean;
  description: string | null;
  // Source freshness signals for `_event_version` (Cut B). `pushed_at` advances on
  // pushes (the `push` webhook), `updated_at` on metadata edits; the normalizer
  // takes the max. Nullable — a partial projection must not fabricate a timestamp.
  updated_at: string | null;
  pushed_at: string | null;
}

export async function fetchRepositories(
  octokit: Octokit,
  org: string,
  cursor?: string,
): Promise<FetchResult> {
  const page = cursor ? Number(cursor) : 1;
  const perPage = 100;

  const { data } = await octokit.rest.repos.listForOrg({
    org,
    per_page: perPage,
    page,
    type: 'all',
  });

  const entities: GitHubRepo[] = data.map((repo) => ({
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
  }));

  return {
    entities,
    cursor: data.length === perPage ? String(page + 1) : undefined,
    has_more: data.length === perPage,
  };
}
