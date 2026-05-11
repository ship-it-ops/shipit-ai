/**
 * Demo data seeder for ShipIt-AI Walking Skeleton.
 *
 * Seeds the Neo4j graph with sample data to demonstrate the full pipeline:
 * repositories, teams, persons, pipelines, and their relationships.
 *
 * Usage: npx tsx scripts/seed-demo.ts
 */
import neo4j from 'neo4j-driver';

const NEO4J_URI = process.env['NEO4J_URI'] ?? 'bolt://localhost:7687';
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? 'shipit-dev';

interface SeedNode {
  label: string;
  id: string;
  properties: Record<string, unknown>;
  claims: Array<{
    property_key: string;
    value: unknown;
    source: string;
    source_id: string;
    confidence: number;
  }>;
}

interface SeedEdge {
  type: string;
  fromId: string;
  toId: string;
  source: string;
  confidence: number;
}

const now = new Date().toISOString();

const nodes: SeedNode[] = [
  // Repositories
  ...['payments-api', 'checkout-service', 'user-service', 'frontend-app', 'shared-lib'].map(
    (name) => ({
      label: 'Repository',
      id: `shipit://repository/default/${name}`,
      properties: {
        name,
        url: `https://github.com/acme-corp/${name}`,
        default_branch: 'main',
        visibility: name === 'shared-lib' ? 'public' : 'private',
        language: name === 'frontend-app' ? 'TypeScript' : 'Go',
      },
      claims: [
        {
          property_key: 'name',
          value: name,
          source: 'github',
          source_id: `github://acme-corp/${name}`,
          confidence: 0.9,
        },
        {
          property_key: 'language',
          value: name === 'frontend-app' ? 'TypeScript' : 'Go',
          source: 'github',
          source_id: `github://acme-corp/${name}`,
          confidence: 0.9,
        },
      ],
    }),
  ),
  // Teams
  ...['platform', 'payments', 'frontend'].map((name) => ({
    label: 'Team',
    id: `shipit://team/default/${name}`,
    properties: { name: `${name.charAt(0).toUpperCase()}${name.slice(1)} Team`, slug: name },
    claims: [
      {
        property_key: 'name',
        value: `${name.charAt(0).toUpperCase()}${name.slice(1)} Team`,
        source: 'github',
        source_id: `github://acme-corp/team/${name}`,
        confidence: 0.9,
      },
    ],
  })),
  // Persons
  ...['alice', 'bob', 'charlie', 'diana'].map((name) => ({
    label: 'Person',
    id: `shipit://person/default/${name}`,
    properties: { login: name, url: `https://github.com/${name}` },
    claims: [
      {
        property_key: 'login',
        value: name,
        source: 'github',
        source_id: `github://acme-corp/user/${name}`,
        confidence: 0.9,
      },
    ],
  })),
  // Pipelines
  ...['payments-api-ci', 'checkout-service-ci', 'frontend-app-ci'].map((name) => ({
    label: 'Pipeline',
    id: `shipit://pipeline/default/${name}`,
    properties: { name, state: 'active' },
    claims: [
      {
        property_key: 'name',
        value: name,
        source: 'github',
        source_id: `github://acme-corp/${name}`,
        confidence: 0.9,
      },
    ],
  })),
];

const edges: SeedEdge[] = [
  // Team membership
  {
    type: 'MEMBER_OF',
    fromId: 'shipit://person/default/alice',
    toId: 'shipit://team/default/platform',
    source: 'github',
    confidence: 0.9,
  },
  {
    type: 'MEMBER_OF',
    fromId: 'shipit://person/default/bob',
    toId: 'shipit://team/default/payments',
    source: 'github',
    confidence: 0.9,
  },
  {
    type: 'MEMBER_OF',
    fromId: 'shipit://person/default/charlie',
    toId: 'shipit://team/default/payments',
    source: 'github',
    confidence: 0.9,
  },
  {
    type: 'MEMBER_OF',
    fromId: 'shipit://person/default/diana',
    toId: 'shipit://team/default/frontend',
    source: 'github',
    confidence: 0.9,
  },
  // Codeowners
  {
    type: 'CODEOWNER_OF',
    fromId: 'shipit://team/default/payments',
    toId: 'shipit://repository/default/payments-api',
    source: 'github',
    confidence: 0.95,
  },
  {
    type: 'CODEOWNER_OF',
    fromId: 'shipit://team/default/payments',
    toId: 'shipit://repository/default/checkout-service',
    source: 'github',
    confidence: 0.95,
  },
  {
    type: 'CODEOWNER_OF',
    fromId: 'shipit://team/default/frontend',
    toId: 'shipit://repository/default/frontend-app',
    source: 'github',
    confidence: 0.95,
  },
  {
    type: 'CODEOWNER_OF',
    fromId: 'shipit://team/default/platform',
    toId: 'shipit://repository/default/shared-lib',
    source: 'github',
    confidence: 0.95,
  },
  // Pipelines
  {
    type: 'BUILT_BY',
    fromId: 'shipit://repository/default/payments-api',
    toId: 'shipit://pipeline/default/payments-api-ci',
    source: 'github',
    confidence: 0.9,
  },
  {
    type: 'BUILT_BY',
    fromId: 'shipit://repository/default/checkout-service',
    toId: 'shipit://pipeline/default/checkout-service-ci',
    source: 'github',
    confidence: 0.9,
  },
  {
    type: 'BUILT_BY',
    fromId: 'shipit://repository/default/frontend-app',
    toId: 'shipit://pipeline/default/frontend-app-ci',
    source: 'github',
    confidence: 0.9,
  },
  // Dependencies
  {
    type: 'DEPENDS_ON',
    fromId: 'shipit://repository/default/checkout-service',
    toId: 'shipit://repository/default/payments-api',
    source: 'github',
    confidence: 0.85,
  },
  {
    type: 'DEPENDS_ON',
    fromId: 'shipit://repository/default/frontend-app',
    toId: 'shipit://repository/default/checkout-service',
    source: 'github',
    confidence: 0.85,
  },
  {
    type: 'DEPENDS_ON',
    fromId: 'shipit://repository/default/payments-api',
    toId: 'shipit://repository/default/shared-lib',
    source: 'github',
    confidence: 0.85,
  },
  {
    type: 'DEPENDS_ON',
    fromId: 'shipit://repository/default/checkout-service',
    toId: 'shipit://repository/default/shared-lib',
    source: 'github',
    confidence: 0.85,
  },
];

async function seed() {
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));

  try {
    await driver.verifyConnectivity();
    console.log('Connected to Neo4j');

    const session = driver.session();

    try {
      // Seed nodes
      for (const node of nodes) {
        const claimsWithTimestamp = node.claims.map((c) => ({
          ...c,
          ingested_at: now,
          evidence: null,
        }));

        await session.run(
          `MERGE (n:${node.label} {id: $id})
           SET n += $properties,
               n._claims = $claims,
               n._source_system = 'github',
               n._source_org = 'github/acme-corp',
               n._last_synced = $now,
               n._event_version = 1`,
          {
            id: node.id,
            properties: node.properties,
            claims: JSON.stringify(claimsWithTimestamp),
            now,
          },
        );
        console.log(`  Created ${node.label}: ${node.properties['name'] ?? node.id}`);
      }

      // Seed edges
      for (const edge of edges) {
        await session.run(
          `MATCH (a {id: $fromId})
           MATCH (b {id: $toId})
           MERGE (a)-[r:${edge.type}]->(b)
           SET r._source = $source,
               r._confidence = $confidence,
               r._ingested_at = $now`,
          {
            fromId: edge.fromId,
            toId: edge.toId,
            source: edge.source,
            confidence: edge.confidence,
            now,
          },
        );
        console.log(`  Created edge: ${edge.type} (${edge.fromId} -> ${edge.toId})`);
      }

      // Verify counts
      const result = await session.run(
        `MATCH (n) RETURN labels(n)[0] AS label, count(n) AS count
         ORDER BY label`,
      );
      console.log('\nGraph summary:');
      for (const record of result.records) {
        console.log(`  ${record.get('label')}: ${record.get('count')}`);
      }

      const edgeResult = await session.run(
        `MATCH ()-[r]->() RETURN type(r) AS type, count(r) AS count
         ORDER BY type`,
      );
      for (const record of edgeResult.records) {
        console.log(`  ${record.get('type')}: ${record.get('count')} edges`);
      }

      console.log('\nDemo data seeded successfully!');
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
