import type { Octokit } from '@octokit/rest';
import type { FetchResult } from '@shipit-ai/connector-sdk';

export interface CodeownersEntry {
  pattern: string;
  owners: string[];
  repo_name: string;
  repo_full_name: string;
}

const CODEOWNERS_PATHS = ['CODEOWNERS', '.github/CODEOWNERS', 'docs/CODEOWNERS'];

export async function fetchCodeowners(
  octokit: Octokit,
  org: string,
  repos: string[],
  cursor?: string,
): Promise<FetchResult> {
  const startIndex = cursor ? Number(cursor) : 0;
  const endIndex = Math.min(startIndex + 10, repos.length);
  const entities: CodeownersEntry[] = [];

  for (let i = startIndex; i < endIndex; i++) {
    const repoName = repos[i];
    const content = await fetchCodeownersFile(octokit, org, repoName);
    if (content) {
      const entries = parseCodeowners(content, repoName, org);
      entities.push(...entries);
    }
  }

  return {
    entities,
    cursor: endIndex < repos.length ? String(endIndex) : undefined,
    has_more: endIndex < repos.length,
  };
}

async function fetchCodeownersFile(
  octokit: Octokit,
  org: string,
  repo: string,
): Promise<string | null> {
  for (const path of CODEOWNERS_PATHS) {
    try {
      const { data } = await octokit.rest.repos.getContent({
        owner: org,
        repo,
        path,
      });

      if ('content' in data && typeof data.content === 'string') {
        return Buffer.from(data.content, 'base64').toString('utf-8');
      }
    } catch {
      // Try next path
    }
  }
  return null;
}

export function parseCodeowners(content: string, repoName: string, org: string): CodeownersEntry[] {
  const entries: CodeownersEntry[] = [];

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;

    const pattern = parts[0];
    const owners = parts.slice(1).filter((p) => p.startsWith('@'));

    if (owners.length > 0) {
      entries.push({
        pattern,
        owners,
        repo_name: repoName,
        repo_full_name: `${org}/${repoName}`,
      });
    }
  }

  return entries;
}
