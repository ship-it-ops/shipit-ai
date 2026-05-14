/**
 * Probes Neo4j for any business-data nodes (i.e. anything that isn't internal
 * Core-Writer / schema bookkeeping).
 *
 * Exit code:
 *   0 — graph has data, no need to seed
 *   1 — graph is empty, recommend seeding
 *   2 — couldn't reach Neo4j (don't treat as "empty"; let the caller decide)
 *
 * Used by `scripts/maybe-seed.sh` to decide whether to prompt the user.
 */
import neo4j from 'neo4j-driver';

const URI = process.env['NEO4J_URI'] ?? 'bolt://localhost:7687';
const USER = process.env['NEO4J_USER'] ?? 'neo4j';
const PASSWORD = process.env['NEO4J_PASSWORD'] ?? 'shipit-dev';

async function main(): Promise<number> {
  const driver = neo4j.driver(URI, neo4j.auth.basic(USER, PASSWORD));
  try {
    try {
      await driver.verifyConnectivity();
    } catch {
      return 2;
    }

    const session = driver.session();
    try {
      const result = await session.run(
        `MATCH (n)
         WHERE NOT n:LinkingKey AND NOT n:_LinkingKey
           AND NOT n:IdempotencyLog AND NOT n:_IdempotencyLog
           AND NOT n:SchemaNodeType AND NOT n:SchemaRelType
         RETURN count(n) AS c`,
      );
      const raw = result.records[0]?.get('c');
      const count =
        typeof raw === 'object' &&
        raw &&
        typeof (raw as { toNumber?: () => number }).toNumber === 'function'
          ? (raw as { toNumber: () => number }).toNumber()
          : Number(raw);
      return count > 0 ? 0 : 1;
    } finally {
      await session.close();
    }
  } finally {
    await driver.close();
  }
}

main()
  .then((code) => process.exit(code))
  .catch(() => process.exit(2));
