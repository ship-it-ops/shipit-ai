import { describe, it, expect } from 'vitest';
import { checkReadOnlyCypher } from '../cypher/read-only-guard.js';

/** 'accepted', or the code the query was refused with. */
function outcome(cypher: string): string {
  const verdict = checkReadOnlyCypher(cypher);
  return verdict.ok ? 'accepted' : verdict.code;
}

describe('checkReadOnlyCypher', () => {
  describe('ordinary reads', () => {
    it.each([
      // The Query Playground's starter queries.
      `MATCH (n)
RETURN labels(n)[0] AS label, count(*) AS count
ORDER BY count DESC`,
      `MATCH (s:LogicalService)
WHERE s.tier_effective = 1 OR s.tier = 1
RETURN s.id AS id, s.name AS name, s.owner_effective AS owner
LIMIT 50`,
      `MATCH (d:Deployment)
WHERE d._last_synced < datetime() - duration({hours: 24})
RETURN d.id AS id, d.name AS name, d._last_synced AS lastSync
ORDER BY d._last_synced ASC
LIMIT 50`,
      `MATCH (s:LogicalService)
WHERE NOT (s)<-[:OWNS]-(:Team)
RETURN s.id AS id, s.name AS name
LIMIT 50`,
      // The graph_query example in docs/mcp-tools.md.
      'MATCH (s:LogicalService)-[:DEPENDS_ON]->(d:LogicalService) WHERE s.name_effective = $name RETURN d.name_effective AS dependency',
      'MATCH path = shortestPath((a)-[*..5]-(b)) RETURN path',
      'MATCH (s:LogicalService) OPTIONAL MATCH (s)<-[:OWNS]-(t:Team) WITH s, collect(t.name) AS teams UNWIND teams AS team RETURN s.name, team ORDER BY team SKIP 5 LIMIT 10',
      'MATCH (a:Team) RETURN a.name AS name UNION MATCH (p:Person) RETURN p.name AS name',
      'MATCH (s:LogicalService) WHERE EXISTS { (s)<-[:OWNS]-(:Team) } RETURN COUNT { (s)-[:DEPENDS_ON]->() } AS deps',
      "MATCH (n) WHERE n.name =~ '(?i)pay.*' AND n.tier IN [1, 2] RETURN n.name, 1.5e3 AS f, 0x1F AS h",
      'MATCH (a)-[r:DEPENDS_ON*1..3]->(b) RETURN a.name, b.name, collect(r)[0..2] AS firstTwo',
      'MATCH (n:LogicalService&!Deprecated) RETURN n {.name, .tier} AS service, n {.*} AS everything',
      "MATCH (n) RETURN CASE WHEN n.tier = 1 THEN 'critical' ELSE 'normal' END AS kind, [x IN [1, 2, 3] WHERE x > 1 | x * 2] AS doubled",
      'MATCH (d:Deployment) RETURN date().year AS year, duration.inDays(d.created, date()).days AS age',
      'EXPLAIN MATCH (n) RETURN n',
      'PROFILE MATCH (n) RETURN n LIMIT 5',
      'MATCH (n) RETURN n LIMIT 10;',
    ])('accepts %s', (cypher) => {
      expect(checkReadOnlyCypher(cypher)).toEqual({ ok: true });
    });

    it('accepts a subquery, with or without an import list', () => {
      expect(
        outcome(
          'MATCH (s:LogicalService) CALL { WITH s MATCH (s)-[:DEPENDS_ON]->(d) RETURN count(d) AS deps } RETURN s.name, deps',
        ),
      ).toBe('accepted');
      expect(
        outcome(
          'MATCH (s:LogicalService) CALL (s) { MATCH (s)-[:DEPENDS_ON]->(d) RETURN count(d) AS deps } RETURN s.name, deps',
        ),
      ).toBe('accepted');
      expect(outcome('CALL () { MATCH (n) RETURN count(n) AS c } RETURN c')).toBe('accepted');
      expect(outcome('MATCH (n) CALL (*) { RETURN 1 AS one } RETURN n, one')).toBe('accepted');
    });
  });

  it('refuses a query with nothing to run', () => {
    expect(outcome('')).toBe('EMPTY');
    expect(outcome('   \n  ')).toBe('EMPTY');
    expect(outcome('// only a comment')).toBe('EMPTY');
  });

  describe('clauses that write, administer or import', () => {
    it.each([
      ['CREATE (n:Foo)', 'CREATE'],
      ['INSERT (n:Foo)', 'INSERT'],
      ['MERGE (n:Foo {id: 1})', 'MERGE'],
      ['MATCH (n) SET n.tier = 1', 'SET'],
      ['MATCH (n) REMOVE n.tier', 'REMOVE'],
      ['MATCH (n) DELETE n', 'DELETE'],
      ['MATCH (n) DETACH DELETE n', 'DETACH'],
      ['MATCH (n) NODETACH DELETE n', 'NODETACH'],
      ['MATCH (n) FOREACH (x IN [] | SET n.x = 1) RETURN n', 'FOREACH'],
      ['LOAD CSV FROM "file.csv" AS row RETURN row', 'LOAD'],
      ['DROP INDEX my_index', 'DROP'],
      ['ALTER DATABASE foo', 'ALTER'],
      ['RENAME USER a TO b', 'RENAME'],
      ['GRANT ROLE reader TO a', 'GRANT'],
      ['DENY TRAVERSE ON GRAPH foo TO reader', 'DENY'],
      ['REVOKE ROLE reader FROM a', 'REVOKE'],
      ['START DATABASE foo', 'START'],
      ['STOP DATABASE foo', 'STOP'],
      ['ENABLE SERVER "a"', 'ENABLE'],
      ['DEALLOCATE DATABASES FROM SERVER "a"', 'DEALLOCATE'],
      ['REALLOCATE DATABASES', 'REALLOCATE'],
      ['DRYRUN REALLOCATE DATABASES', 'DRYRUN'],
      ['TERMINATE TRANSACTION "neo4j-transaction-1"', 'TERMINATE'],
      ['SHOW USERS', 'SHOW'],
      ['USE other MATCH (n) RETURN n', 'USE'],
      [
        'MATCH (n) CALL { WITH n MATCH (n)--(m) RETURN m } IN TRANSACTIONS RETURN m',
        'TRANSACTIONS',
      ],
    ])('refuses "%s" and names %s', (cypher, keyword) => {
      expect(checkReadOnlyCypher(cypher)).toMatchObject({
        ok: false,
        code: 'WRITE_KEYWORD',
        keyword,
      });
    });

    it('finds the clause whatever its case or spacing', () => {
      expect(outcome('create (n:Foo)')).toBe('WRITE_KEYWORD');
      expect(outcome('  CrEaTe  (n)')).toBe('WRITE_KEYWORD');
      expect(outcome('\n\t  CREATE\n  (n:Foo)\n')).toBe('WRITE_KEYWORD');
      expect(outcome('MATCH (n)\n  SET n.tier = 1\n  RETURN n')).toBe('WRITE_KEYWORD');
    });

    it('finds the clause when nothing separates it from what comes before', () => {
      expect(outcome('MATCH (n)SET n.x = 1')).toBe('WRITE_KEYWORD');
      expect(outcome("MATCH (n) WHERE n.x = 'a'SET n.y = 1")).toBe('WRITE_KEYWORD');
      expect(outcome('MATCH (n:`Foo`)SET n.x = 1')).toBe('WRITE_KEYWORD');
    });

    it('reads on after a line comment that ends in a carriage return', () => {
      expect(outcome('MATCH (n) // note\rSET n.x = 1')).toBe('WRITE_KEYWORD');
    });

    it('does not mistake a string for a clause', () => {
      expect(outcome("MATCH (n {name: 'CreateAccount'}) RETURN n")).toBe('accepted');
      expect(outcome('MATCH (n) WHERE n.action = "DELETE" RETURN n')).toBe('accepted');
      expect(outcome("MATCH (n) WHERE n.label = 'SET top' RETURN n")).toBe('accepted');
      expect(outcome("MATCH (n) WHERE n.note = 'it\\'s SET' RETURN n")).toBe('accepted');
    });

    it('does not mistake a comment for a clause', () => {
      expect(outcome('// CREATE blocked\nMATCH (n) RETURN n')).toBe('accepted');
      expect(outcome('/* SET this */ MATCH (n) RETURN n')).toBe('accepted');
    });

    it('does not mistake a quoted name, a longer name or a parameter for a clause', () => {
      expect(outcome('MATCH (n:`My-Label-Create`) RETURN n')).toBe('accepted');
      expect(outcome('MATCH (n) RETURN n.`set`, n.`a``b`')).toBe('accepted');
      expect(outcome('MATCH (n) RETURN n.createdAt, n.offset, n.dataset_id')).toBe('accepted');
      expect(outcome('MATCH (n {name: "RESET_TOKEN"}) RETURN n')).toBe('accepted');
      expect(outcome('MATCH (n) WHERE n.id = $set OR n.id = $1 RETURN n')).toBe('accepted');
    });
  });

  describe('procedures', () => {
    it.each([
      'CALL db.labels() YIELD label RETURN label',
      'CALL db.relationshipTypes()',
      'CALL db.propertyKeys',
      'CALL db.schema.visualization()',
      'MATCH (n:Team) CALL apoc.path.subgraphAll(n, {maxLevel: 2}) YIELD nodes RETURN nodes',
      'CALL `db`.`labels`() YIELD label RETURN label',
    ])('accepts a read procedure on the list: %s', (cypher) => {
      expect(outcome(cypher)).toBe('accepted');
    });

    it.each([
      'CALL some.other.procedure()',
      'CALL some.other.procedure',
      'CALL `some`.`other`.`procedure`()',
      'CALL some . other /* spaced */ . procedure()',
      'OPTIONAL CALL some.other.procedure()',
      'CALL lonelyName()',
      'CALL db.createLabel("X")',
      'CALL apoc.path.somethingElse(n)',
      'CALL DB.LABELS()',
      // What the Query Playground's deny-list named, kept as a regression.
      'CALL apoc.periodic.iterate("...", "...", {})',
      'CALL apoc.refactor.mergeNodes([n1, n2])',
      'CALL apoc.create.node(["X"], {})',
      'CALL apoc.cypher.run("RETURN 1", {})',
    ])('refuses any other procedure: %s', (cypher) => {
      expect(checkReadOnlyCypher(cypher)).toMatchObject({
        ok: false,
        code: 'PROCEDURE',
        keyword: 'CALL',
      });
    });

    it('names the procedure it refused', () => {
      const verdict = checkReadOnlyCypher('CALL `some`.other.procedure()');
      expect(verdict.ok ? '' : verdict.message).toContain('some.other.procedure');
    });

    it('refuses CALL with nothing it can identify after it', () => {
      expect(outcome('CALL')).toBe('PROCEDURE');
      expect(outcome('CALL 5')).toBe('PROCEDURE');
      expect(outcome('MATCH (n) CALL (n) RETURN n')).toBe('PROCEDURE');
    });
  });

  describe('functions', () => {
    it('accepts the built-in functions, which have no namespace', () => {
      expect(
        outcome(
          "RETURN toUpper('a'), size([1, 2]), coalesce(null, 1), datetime(), duration({hours: 1})",
        ),
      ).toBe('accepted');
    });

    it.each([
      "RETURN date.truncate('month', date()) AS d",
      'RETURN duration.between(date(), date()) AS x',
      'RETURN point.distance(point({x: 0, y: 0}), point({x: 1, y: 1})) AS dist',
      "RETURN DATETIME.TRUNCATE('day', datetime()) AS d",
      'MATCH (n) RETURN apoc.convert.fromJsonList(n._claims) AS claims',
    ])('accepts a namespaced function on the list: %s', (cypher) => {
      expect(outcome(cypher)).toBe('accepted');
    });

    it.each([
      'RETURN some.namespace.fn(1)',
      'RETURN `some`.`namespace`.`fn`(1)',
      'RETURN some . namespace . fn (1)',
      'RETURN apoc.something.else(1)',
      'MATCH (n) WHERE other.check(n) RETURN n',
      // Wherever it stands: after a range, a closing bracket, a number.
      'RETURN [1, 2, 3][0..some.namespace.fn(1)]',
      'RETURN [1, 2, 3][some.namespace.fn(1)..]',
      'MATCH (n) RETURN n {.name, extra: some.namespace.fn(n)}',
      'RETURN 1 + some.namespace.fn(1), -some.namespace.fn(2)',
    ])('refuses any other namespaced function: %s', (cypher) => {
      expect(outcome(cypher)).toBe('FUNCTION');
    });

    it('names the function it refused', () => {
      const verdict = checkReadOnlyCypher('RETURN some.namespace.fn(1)');
      expect(verdict.ok ? '' : verdict.message).toContain('some.namespace.fn');
    });

    it('does not take a property for a function', () => {
      expect(outcome('MATCH (n) RETURN n.name, (n.tier) + (1)')).toBe('accepted');
      expect(
        outcome('MATCH (n) WHERE n.tier IN [1] RETURN nodes(shortestPath((n)-[*..2]-(n)))[0].name'),
      ).toBe('accepted');
    });
  });

  // The three rules above look at single words, so none may depend on what
  // stands before the word. Whatever the query would mean, each must fire.
  describe('wherever the word stands', () => {
    const BEFORE = [
      ...'!#%&()*+,-/:<=>?@[]^{|}~',
      '..',
      '1 ',
      '1.',
      "'s'",
      '"s"',
      '$p ',
      'x ',
      'x.',
      '`q`',
      '`q`.',
      ').',
      '].',
      'AND ',
      '/* c */',
      '// c\n',
      '\t',
      '\r',
    ];

    it.each(BEFORE)('refuses a write clause after %j', (before) => {
      expect(outcome(`MATCH (n) RETURN 1 ${before}SET n.x = 1`)).toBe('WRITE_KEYWORD');
    });

    it.each(BEFORE)('refuses an unlisted procedure after %j', (before) => {
      expect(outcome(`MATCH (n) RETURN 1 ${before}CALL some.other.procedure()`)).toBe('PROCEDURE');
    });

    it.each(BEFORE)('refuses an unlisted namespaced function after %j', (before) => {
      expect(outcome(`MATCH (n) RETURN 1 ${before}some.namespace.fn(1)`)).toBe('FUNCTION');
    });

    // Glued to a number, the word may or may not be a word of its own to the
    // database. The query is refused without deciding which.
    it.each(['1', '1.5', '1e3', '0x1F', '$1'])('refuses all three straight after %j', (before) => {
      expect(outcome(`MATCH (n) RETURN ${before}SET n.x = 1`)).toBe('UNREADABLE');
      expect(outcome(`MATCH (n) RETURN ${before}CALL some.other.procedure()`)).toBe('UNREADABLE');
      expect(outcome(`MATCH (n) RETURN ${before}some.namespace.fn(1)`)).toBe('UNREADABLE');
    });
  });

  describe('text it cannot read the way the database will', () => {
    it('refuses an escape sequence the database decodes before it reads the query', () => {
      expect(outcome('RETURN 1 AS \\u0061bc')).toBe('UNREADABLE');
      expect(outcome("RETURN '\\u0041' AS s")).toBe('UNREADABLE');
      expect(outcome('// note \\u0041\nRETURN 1')).toBe('UNREADABLE');
    });

    it('refuses a character outside ASCII unless it is inside a string, a quoted name or a block comment', () => {
      expect(outcome('MATCH (n)\u00a0RETURN n')).toBe('UNREADABLE');
      expect(outcome('MATCH (n) RETURN n.caf\u00e9')).toBe('UNREADABLE');
      expect(outcome("MATCH (n {name: 'caf\u00e9'}) RETURN n")).toBe('accepted');
      expect(outcome('MATCH (n) RETURN n.`caf\u00e9`')).toBe('accepted');
      expect(outcome('/* caf\u00e9 */ MATCH (n) RETURN n')).toBe('accepted');
      expect(outcome('MATCH (n) RETURN n // caf\u00e9')).toBe('accepted');
    });

    it('refuses a control character or an unusual line break', () => {
      expect(outcome('MATCH (n)\u000cRETURN n')).toBe('UNREADABLE');
      expect(outcome('MATCH (n) // note\u2028RETURN n')).toBe('UNREADABLE');
      expect(outcome('MATCH (n) // note\u0085RETURN n')).toBe('UNREADABLE');
    });

    it('refuses a string, a quoted name or a block comment that never ends', () => {
      expect(outcome("MATCH (n {name: 'abc}) RETURN n")).toBe('UNREADABLE');
      expect(outcome('MATCH (n:`Open) RETURN n')).toBe('UNREADABLE');
      expect(outcome('MATCH (n) /* never closed RETURN n')).toBe('UNREADABLE');
    });

    it('refuses a backslash outside a string', () => {
      expect(outcome('MATCH (n) RETURN n \\ 2')).toBe('UNREADABLE');
    });

    it('refuses a number that runs into a name', () => {
      expect(outcome('MATCH (n) WHERE n.tier = 1abc RETURN n')).toBe('UNREADABLE');
      expect(outcome('MATCH (n) WHERE n.tier = 0x1Fzz RETURN n')).toBe('UNREADABLE');
    });

    it('refuses a numbered parameter that runs into a name', () => {
      expect(outcome('MATCH (n) WHERE n.id = $1abc RETURN n')).toBe('UNREADABLE');
      expect(outcome('MATCH (n) WHERE n.id = $1 RETURN n')).toBe('accepted');
    });

    it('refuses more than one statement', () => {
      expect(outcome('RETURN 1 AS x; RETURN 2 AS y')).toBe('UNREADABLE');
    });
  });

  describe('size', () => {
    it('refuses a query longer than 100,000 characters', () => {
      const padding = 'x'.repeat(100_000);
      expect(outcome(`RETURN 1 // ${padding}`)).toBe('TOO_LONG');
      expect(outcome(`RETURN 1 // ${padding.slice(0, 1_000)}`)).toBe('accepted');
    });

    it('decides in time proportional to the length of the query', () => {
      // About the longest queries it reads, built from the constructs that
      // need looking ahead: a parenthesis after CALL, and a dotted name.
      const started = performance.now();
      expect(outcome('CALL ('.repeat(11_000) + ') {'.repeat(11_000))).toBe('PROCEDURE');
      expect(outcome('a.'.repeat(49_000) + 'b(1)')).toBe('FUNCTION');
      expect(performance.now() - started).toBeLessThan(1_000);
    });
  });

  describe('internal labels', () => {
    it.each([
      'MATCH (t:_AccessToken) RETURN t',
      'MATCH (t:`_LinkingKey`) RETURN t',
      'MATCH (n:Repository|_IdempotencyLog) RETURN n',
      'MATCH (n) WHERE n:_AccessToken RETURN n',
    ])('refuses a query that names one: %s', (cypher) => {
      expect(outcome(cypher)).toBe('INTERNAL_LABEL');
    });

    it('leaves properties that start with an underscore alone', () => {
      expect(
        outcome('MATCH (d:Deployment) WHERE d._last_synced IS NOT NULL RETURN d._last_synced'),
      ).toBe('accepted');
      expect(outcome('MATCH (n {_absent_since: null}) RETURN n')).toBe('accepted');
    });
  });
});
