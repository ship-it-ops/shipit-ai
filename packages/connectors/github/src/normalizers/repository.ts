import type { CanonicalNode, CanonicalEdge, PropertyClaim } from '@shipit-ai/shared';
import {
  buildScopedCanonicalId,
  buildLinkingKey,
  deriveTimeVersion,
  deriveContentVersion,
} from '@shipit-ai/shared';
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

  const properties = {
    name: repo.name,
    url: repo.html_url,
    default_branch: repo.default_branch,
    visibility: repo.visibility,
    language: repo.language,
    topics: repo.topics,
    archived: repo.archived,
    description: repo.description,
  };

  // Freshness/ordering token: epoch ms from the source timestamps (pushed_at
  // advances on pushes, updated_at on metadata; take the max). Falls back to a
  // stable content hash when neither timestamp is present (e.g. a partial webhook
  // projection) — never a poisoned 0/NaN that would wedge the freshness guard.
  const eventVersion =
    deriveTimeVersion(repo.updated_at, repo.pushed_at) ?? deriveContentVersion(properties);

  const node: CanonicalNode = {
    id: buildScopedCanonicalId('Repository', 'default', org, repo.name),
    label: 'Repository',
    properties,
    _claims: claims,
    _source_system: 'github',
    _source_org: `github/${org}`,
    _source_id: sourceId,
    _last_synced: now,
    _event_version: eventVersion,
  };

  return { nodes: [node], edges: [] };
}
