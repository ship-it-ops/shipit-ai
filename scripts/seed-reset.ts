/**
 * Clears all data from the Neo4j graph.
 *
 * Usage: npx tsx scripts/seed-reset.ts
 */
import neo4j from 'neo4j-driver';

const NEO4J_URI = process.env['NEO4J_URI'] ?? 'bolt://localhost:7687';
const NEO4J_USER = process.env['NEO4J_USER'] ?? 'neo4j';
const NEO4J_PASSWORD = process.env['NEO4J_PASSWORD'] ?? 'shipit-dev';

async function reset() {
  const driver = neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USER, NEO4J_PASSWORD));

  try {
    await driver.verifyConnectivity();
    console.log('Connected to Neo4j');

    const session = driver.session();
    try {
      const result = await session.run('MATCH (n) DETACH DELETE n RETURN count(n) AS deleted');
      const deleted = result.records[0]?.get('deleted');
      const count =
        typeof deleted === 'object' && deleted?.toNumber ? deleted.toNumber() : Number(deleted);
      console.log(`Deleted ${count} nodes (and all relationships)`);
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
}

reset().catch((err) => {
  console.error('Reset failed:', err);
  process.exit(1);
});
