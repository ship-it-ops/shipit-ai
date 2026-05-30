import type { CanonicalNode, CanonicalEdge, PropertyClaim } from '@shipit-ai/shared';
import { buildCanonicalId, buildScopedCanonicalId, buildLinkingKey } from '@shipit-ai/shared';
import type { GitHubTeam } from '../fetchers/teams.js';

function makeClaim(key: string, value: unknown, sourceId: string): PropertyClaim {
  return {
    property_key: key,
    value,
    source: 'github',
    source_id: sourceId,
    ingested_at: new Date().toISOString(),
    confidence: 0.9,
    evidence: null,
  };
}

export function normalizeTeam(
  team: GitHubTeam,
  org: string,
): { nodes: CanonicalNode[]; edges: CanonicalEdge[] } {
  const now = new Date().toISOString();
  const teamSourceId = buildLinkingKey('github', org, 'team', team.slug);

  const teamNode: CanonicalNode = {
    id: buildScopedCanonicalId('Team', 'default', org, team.slug),
    label: 'Team',
    properties: {
      name: team.name,
      slug: team.slug,
      description: team.description,
      privacy: team.privacy,
      url: team.html_url,
    },
    _claims: [
      makeClaim('name', team.name, teamSourceId),
      makeClaim('slug', team.slug, teamSourceId),
      makeClaim('description', team.description, teamSourceId),
      makeClaim('privacy', team.privacy, teamSourceId),
      makeClaim('url', team.html_url, teamSourceId),
    ],
    _source_system: 'github',
    _source_org: `github/${org}`,
    _source_id: teamSourceId,
    _last_synced: now,
    _event_version: 1,
  };

  const nodes: CanonicalNode[] = [teamNode];
  const edges: CanonicalEdge[] = [];

  for (const member of team.members) {
    const personSourceId = buildLinkingKey('github', org, 'user', member.login);

    const personNode: CanonicalNode = {
      // Person stays unscoped — a GitHub login is globally unique across orgs.
      id: buildCanonicalId('Person', 'default', member.login),
      label: 'Person',
      properties: {
        login: member.login,
        avatar_url: member.avatar_url,
        url: member.html_url,
      },
      _claims: [
        makeClaim('login', member.login, personSourceId),
        makeClaim('avatar_url', member.avatar_url, personSourceId),
        makeClaim('url', member.html_url, personSourceId),
      ],
      _source_system: 'github',
      _source_org: `github/${org}`,
      _source_id: personSourceId,
      _last_synced: now,
      _event_version: 1,
    };

    nodes.push(personNode);

    edges.push({
      type: 'MEMBER_OF',
      from: personNode.id,
      to: teamNode.id,
      properties: { role: member.role },
      _source: 'github',
      _confidence: 0.9,
      _ingested_at: now,
    });
  }

  return { nodes, edges };
}
