import type { CanonicalEdge } from '@shipit-ai/shared';
import { buildCanonicalId, buildScopedCanonicalId } from '@shipit-ai/shared';
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
      // a CODEOWNERS file in contoso that references @acme-corp/platform
      // doesn't collapse onto contoso's `platform` team.
      const [teamOrg, teamSlug] = cleanOwner.split('/');
      ownerId = buildScopedCanonicalId('Team', 'default', teamOrg, teamSlug);
    } else {
      // Person stays unscoped — a GitHub login is globally unique.
      ownerId = buildCanonicalId('Person', 'default', cleanOwner);
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
