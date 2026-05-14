// Phase 2: Team Dashboard backend.
// Reads Team nodes and the relationships seeded by the GitHub connector / demo:
//   (:Team)-[:OWNS]->(:LogicalService|:Repository|:Deployment)
//   (:Person)-[:MEMBER_OF]->(:Team)
//   (:Person)-[:ON_CALL_FOR]->(:LogicalService)  (joined back to teams via OWNS)
import type {
  OnCallAssignment,
  TeamDetail,
  TeamMember,
  TeamOwnedEntity,
  TeamSummary,
} from '@shipit-ai/shared';
import type { Neo4jService } from './neo4j-service.js';

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object' && 'toNumber' in value) {
    return (value as { toNumber: () => number }).toNumber();
  }
  return Number(value ?? 0);
}

function asNullableNumber(value: unknown): number | null {
  if (value == null) return null;
  return asNumber(value);
}

function asString(value: unknown, fallback = ''): string {
  if (value == null) return fallback;
  return String(value);
}

export class TeamService {
  constructor(private neo4j: Neo4jService) {}

  async listTeams(): Promise<TeamSummary[]> {
    const records = await this.neo4j.runQuery(
      `MATCH (t:Team)
       OPTIONAL MATCH (t)-[:OWNS]->(owned)
       OPTIONAL MATCH (p:Person)-[:MEMBER_OF]->(t)
       OPTIONAL MATCH (oc:Person)-[:ON_CALL_FOR]->(svc)<-[:OWNS]-(t)
       WITH t,
            count(DISTINCT owned) AS ownedCount,
            count(DISTINCT p) AS memberCount,
            count(DISTINCT oc) AS onCallCount
       RETURN t, ownedCount, memberCount, onCallCount
       ORDER BY t.name`,
    );

    return records.map((rec) => {
      const t = rec.get('t') as { properties: Record<string, unknown> };
      const props = t.properties;
      return {
        id: asString(props.id),
        name: asString(props.name, asString(props.slug)),
        slug: asString(props.slug, asString(props.name).toLowerCase()),
        email: props.email != null ? asString(props.email) : null,
        description: props.description != null ? asString(props.description) : null,
        ownedCount: asNumber(rec.get('ownedCount')),
        memberCount: asNumber(rec.get('memberCount')),
        onCallCount: asNumber(rec.get('onCallCount')),
      };
    });
  }

  async getTeam(id: string): Promise<TeamDetail | null> {
    const teamRecords = await this.neo4j.runQuery(
      `MATCH (t:Team {id: $id}) RETURN t LIMIT 1`,
      { id },
    );
    if (teamRecords.length === 0) return null;
    const t = teamRecords[0].get('t') as { properties: Record<string, unknown> };
    const props = t.properties;

    const ownedRecords = await this.neo4j.runQuery(
      `MATCH (t:Team {id: $id})-[:OWNS]->(n)
       RETURN n, labels(n) AS labels
       ORDER BY coalesce(n.tier, 99), n.name`,
      { id },
    );
    const services: TeamOwnedEntity[] = [];
    const repositories: TeamOwnedEntity[] = [];
    const deployments: TeamOwnedEntity[] = [];
    for (const rec of ownedRecords) {
      const n = rec.get('n') as { properties: Record<string, unknown> };
      const labels = rec.get('labels') as string[];
      const label = labels[0] ?? 'Unknown';
      const entity: TeamOwnedEntity = {
        id: asString(n.properties.id),
        name: asString(n.properties.name, asString(n.properties.id).split('/').pop() ?? ''),
        label,
        tier: asNullableNumber(n.properties.tier_effective ?? n.properties.tier),
        environment: n.properties.environment ? asString(n.properties.environment) : undefined,
      };
      if (label === 'LogicalService') services.push(entity);
      else if (label === 'Repository') repositories.push(entity);
      else if (label === 'Deployment') deployments.push(entity);
    }

    const memberRecords = await this.neo4j.runQuery(
      `MATCH (p:Person)-[:MEMBER_OF]->(t:Team {id: $id})
       RETURN p
       ORDER BY p.name`,
      { id },
    );
    const members: TeamMember[] = memberRecords.map((rec) => {
      const p = rec.get('p') as { properties: Record<string, unknown> };
      return {
        id: asString(p.properties.id),
        name: asString(p.properties.name, asString(p.properties.login)),
        login: asString(p.properties.login),
        role: p.properties.role != null ? asString(p.properties.role) : null,
      };
    });

    const onCallRecords = await this.neo4j.runQuery(
      `MATCH (p:Person)-[:ON_CALL_FOR]->(svc)<-[:OWNS]-(t:Team {id: $id})
       RETURN p, svc
       ORDER BY svc.name, p.name`,
      { id },
    );
    const onCall: OnCallAssignment[] = onCallRecords.map((rec) => {
      const p = rec.get('p') as { properties: Record<string, unknown> };
      const svc = rec.get('svc') as { properties: Record<string, unknown> };
      return {
        serviceId: asString(svc.properties.id),
        serviceName: asString(svc.properties.name),
        personId: asString(p.properties.id),
        personName: asString(p.properties.name, asString(p.properties.login)),
      };
    });

    return {
      id: asString(props.id),
      name: asString(props.name, asString(props.slug)),
      slug: asString(props.slug, asString(props.name).toLowerCase()),
      email: props.email != null ? asString(props.email) : null,
      description: props.description != null ? asString(props.description) : null,
      ownedCount: services.length + repositories.length + deployments.length,
      memberCount: members.length,
      onCallCount: onCall.length,
      services,
      repositories,
      deployments,
      members,
      onCall,
    };
  }
}
