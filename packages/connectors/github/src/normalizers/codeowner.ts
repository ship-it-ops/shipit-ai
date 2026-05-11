import type { CanonicalEdge } from '@shipit-ai/shared';
import { buildCanonicalId } from '@shipit-ai/shared';
import type { CodeownersEntry } from '../fetchers/codeowners.js';

export function normalizeCodeowner(entry: CodeownersEntry): { nodes: []; edges: CanonicalEdge[] } {
  const now = new Date().toISOString();
  const repoId = buildCanonicalId('Repository', 'default', entry.repo_name);

  const edges: CanonicalEdge[] = [];

  for (const owner of entry.owners) {
    // Owners can be @org/team-name or @username
    const cleanOwner = owner.replace(/^@/, '');
    const isTeam = cleanOwner.includes('/');

    let ownerId: string;
    if (isTeam) {
      const teamSlug = cleanOwner.split('/').pop()!;
      ownerId = buildCanonicalId('Team', 'default', teamSlug);
    } else {
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
