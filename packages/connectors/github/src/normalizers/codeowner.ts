import type { CanonicalEdge } from '@shipit-ai/shared';
import { buildScopedCanonicalId, buildPersonCanonicalId } from '@shipit-ai/shared';
import type { CodeownersEntry } from '../fetchers/codeowners.js';

export function normalizeCodeowner(
  entry: CodeownersEntry,
  org: string,
): { nodes: []; edges: CanonicalEdge[] } {
  const now = new Date().toISOString();
  const repoId = buildScopedCanonicalId('Repository', 'default', org, entry.repo_name);

  const edges: CanonicalEdge[] = [];

  for (const owner of entry.owners) {
    // Owners can be @org/team-name or @username
    const cleanOwner = owner.replace(/^@/, '');
    const isTeam = cleanOwner.includes('/');

    let ownerId: string;
    if (isTeam) {
      // GitHub team refs are always `@<org>/<slug>` — preserve the org so
      // a CODEOWNERS file in cargocloud that references @shipitops/platform
      // doesn't collapse onto cargocloud's `platform` team.
      const [teamOrg, teamSlug] = cleanOwner.split('/');
      ownerId = buildScopedCanonicalId('Team', 'default', teamOrg, teamSlug);
    } else {
      // Person stays unscoped — a GitHub login is globally unique.
      // Lowercased (buildPersonCanonicalId) so a CODEOWNERS entry written
      // `@Mohamed-E` merges with team-membership's `@mohamed-e` and with
      // the login-upsert Person instead of forking into a second node.
      ownerId = buildPersonCanonicalId(cleanOwner);
    }

    edges.push({
      type: 'CODEOWNER_OF',
      from: ownerId,
      to: repoId,
      properties: {
        pattern: entry.pattern,
      },
      _source: 'github',
      _confidence: 0.95,
      _ingested_at: now,
    });
  }

  return { nodes: [], edges };
}
