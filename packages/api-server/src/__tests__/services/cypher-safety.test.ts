import { describe, it, expect } from 'vitest';
import { checkCypherSafety } from '../../services/cypher-safety.js';

describe('checkCypherSafety', () => {
  it('rejects empty queries', () => {
    expect(checkCypherSafety('').safe).toBe(false);
    expect(checkCypherSafety('   \n  ').safe).toBe(false);
  });

  it('allows pure MATCH/RETURN queries', () => {
    expect(checkCypherSafety('MATCH (n) RETURN n LIMIT 10').safe).toBe(true);
    expect(
      checkCypherSafety('MATCH (n:LogicalService) WHERE n.tier = 1 RETURN n.name').safe,
    ).toBe(true);
  });

  it('allows db.* and apoc read procedures', () => {
    expect(checkCypherSafety('CALL db.labels() YIELD label RETURN label').safe).toBe(true);
    expect(
      checkCypherSafety('CALL apoc.path.subgraphAll(n, {}) YIELD nodes RETURN nodes').safe,
    ).toBe(true);
  });

  it.each([
    ['CREATE (n:Foo)', 'CREATE'],
    ['MATCH (n) DELETE n', 'DELETE'],
    ['MATCH (n) DETACH DELETE n', 'DETACH'],
    ['MERGE (n:Foo {id: 1})', 'MERGE'],
    ['MATCH (n) SET n.tier = 1', 'SET'],
    ['MATCH (n) REMOVE n.tier', 'REMOVE'],
    ['DROP INDEX my_index', 'DROP'],
    ['LOAD CSV FROM "file.csv" AS row RETURN row', 'LOAD'],
    ['MATCH (n) FOREACH (x IN [] | SET n.x = 1) RETURN n', 'FOREACH'],
  ])('rejects write keyword in "%s"', (cypher, expectedKeyword) => {
    const result = checkCypherSafety(cypher);
    expect(result.safe).toBe(false);
    expect(result.keyword).toBe(expectedKeyword);
  });

  it('case-insensitive keyword detection', () => {
    expect(checkCypherSafety('create (n:Foo)').safe).toBe(false);
    expect(checkCypherSafety('Create (n:Foo)').safe).toBe(false);
    expect(checkCypherSafety('  CrEaTe  (n)').safe).toBe(false);
  });

  it('does not trigger on write keywords inside string literals', () => {
    // The classic false positive — node name happens to contain "Create".
    expect(checkCypherSafety("MATCH (n {name: 'CreateAccount'}) RETURN n").safe).toBe(true);
    expect(checkCypherSafety('MATCH (n) WHERE n.action = "DELETE" RETURN n').safe).toBe(true);
    expect(checkCypherSafety("MATCH (n) WHERE n.label = 'SET top' RETURN n").safe).toBe(true);
  });

  it('does not trigger on write keywords inside comments', () => {
    expect(checkCypherSafety('// CREATE blocked\nMATCH (n) RETURN n').safe).toBe(true);
    expect(checkCypherSafety('/* SET this */ MATCH (n) RETURN n').safe).toBe(true);
  });

  it('does not trigger on substrings inside identifiers', () => {
    // SET appears inside "RESET" but only as substring — should pass.
    expect(checkCypherSafety('MATCH (n {name: "RESET_TOKEN"}) RETURN n').safe).toBe(true);
    // But the actual SET keyword should still be caught.
    expect(checkCypherSafety('MATCH (n) SET n.x = 1 RETURN n').safe).toBe(false);
  });

  it('blocks transactional and mutating CALL patterns', () => {
    expect(checkCypherSafety('CALL { CREATE (n) } IN TRANSACTIONS').safe).toBe(false);
    expect(checkCypherSafety('CALL apoc.periodic.iterate("...", "...", {})').safe).toBe(false);
    expect(checkCypherSafety('CALL apoc.refactor.mergeNodes([n1, n2])').safe).toBe(false);
    expect(checkCypherSafety('CALL apoc.create.node(["X"], {})').safe).toBe(false);
    expect(checkCypherSafety('CALL apoc.cypher.run("CREATE (n)", {})').safe).toBe(false);
  });

  it('handles backtick-quoted identifiers without false matches', () => {
    expect(checkCypherSafety('MATCH (n:`My-Label-Create`) RETURN n').safe).toBe(true);
  });

  it('rejects adversarial whitespace and multi-line write queries', () => {
    expect(checkCypherSafety('\n\t  CREATE\n  (n:Foo)\n').safe).toBe(false);
    expect(
      checkCypherSafety(`
        MATCH (n)
        SET n.tier = 1
        RETURN n
      `).safe,
    ).toBe(false);
  });
});
