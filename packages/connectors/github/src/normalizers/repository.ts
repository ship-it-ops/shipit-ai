import type { CanonicalNode, CanonicalEdge, PropertyClaim } from '@shipit-ai/shared';
import { buildScopedCanonicalId, buildLinkingKey } from '@shipit-ai/shared';
import type { GitHubRepo } from '../fetchers/repositories.js';

function makeClaim(key: string, value: unknown, org: string, repoName: string): PropertyClaim {
  return {
    property_key: key,
    value,
    source: 'github',
    source_id: buildLinkingKey('github', org, repoName),
    ingested_at: new Date().toISOString(),
    confidence: 0.9,
    evidence: null,
  };
}

export function normalizeRepository(
  repo: GitHubRepo,
  org: string,
): { nodes: CanonicalNode[]; edges: CanonicalEdge[] } {
  const now = new Date().toISOString();
  const sourceId = buildLinkingKey('github', org, repo.name);

  const claims: PropertyClaim[] = [
    makeClaim('name', repo.name, org, repo.name),
    makeClaim('url', repo.html_url, org, repo.name),
    makeClaim('default_branch', repo.default_branch, org, repo.name),
    makeClaim('visibility', repo.visibility, org, repo.name),
    makeClaim('language', repo.language, org, repo.name),
    makeClaim('topics', repo.topics, org, repo.name),
  ];

  const node: CanonicalNode = {
    id: buildScopedCanonicalId('Repository', 'default', org, repo.name),
    label: 'Repository',
    properties: {
      name: repo.name,
      url: repo.html_url,
      default_branch: repo.default_branch,
      visibility: repo.visibility,
      language: repo.language,
      topics: repo.topics,
      archived: repo.archived,
      description: repo.description,
    },
    _claims: claims,
    _source_system: 'github',
    _source_org: `github/${org}`,
    _source_id: sourceId,
    _last_synced: now,
    _event_version: 1,
  };

  return { nodes: [node], edges: [] };
}
