import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TokenService } from '../../services/auth/token-service.js';
import type { Neo4jService } from '../../services/neo4j-service.js';

// In-memory Neo4j stand-in. Token writes/reads go through runQuery only;
// we intercept the Cypher to keep behavior under test without booting a
// real database.

interface TokenRow {
  id: string;
  name: string;
  tokenHash: string;
  salt: string;
  ownerEmail: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  revoked: boolean;
}

function buildNeo4jStub(): { neo4j: Neo4jService; rows: Map<string, TokenRow> } {
  const rows = new Map<string, TokenRow>();
  const neo4j = {
    runQuery: vi.fn(async (cypher: string, params: Record<string, unknown>) => {
      if (cypher.includes('CREATE (t:_AccessToken')) {
        const row: TokenRow = {
          id: String(params.id),
          name: String(params.name),
          tokenHash: String(params.tokenHash),
          salt: String(params.salt),
          ownerEmail: String(params.ownerEmail),
          scopes: (params.scopes as string[]).slice(),
          createdAt: String(params.createdAt),
          lastUsedAt: null,
          revoked: false,
        };
        rows.set(row.id, row);
        return [];
      }
      if (
        cypher.includes('MATCH (t:_AccessToken { ownerEmail') &&
        cypher.includes('ORDER BY t.createdAt')
      ) {
        const owner = String(params.ownerEmail);
        const matching = [...rows.values()]
          .filter((r) => r.ownerEmail === owner)
          .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        return matching.map((r) => ({ get: () => ({ properties: r }) }));
      }
      if (cypher.includes('MATCH (t:_AccessToken { id: $id, ownerEmail')) {
        const id = String(params.id);
        const owner = String(params.ownerEmail);
        const row = rows.get(id);
        if (!row || row.ownerEmail !== owner) return [];
        row.revoked = true;
        return [{ get: () => id }];
      }
      if (cypher.includes('MATCH (t:_AccessToken { id: $id })') && cypher.includes('RETURN t')) {
        const row = rows.get(String(params.id));
        return row ? [{ get: () => ({ properties: row }) }] : [];
      }
      if (cypher.includes('SET t.lastUsedAt')) {
        const row = rows.get(String(params.id));
        if (row) row.lastUsedAt = String(params.ts);
        return [];
      }
      return [];
    }),
  } as unknown as Neo4jService;
  return { neo4j, rows };
}

describe('TokenService', () => {
  let neo4j: Neo4jService;
  let rows: Map<string, TokenRow>;
  let service: TokenService;

  beforeEach(() => {
    const stub = buildNeo4jStub();
    neo4j = stub.neo4j;
    rows = stub.rows;
    service = new TokenService({ neo4j });
  });

  it('mints a token with the shipit_pat_ prefix and persists a hashed secret', async () => {
    const created = await service.create({
      name: 'CI bot',
      ownerEmail: 'admin@example.com',
      scopes: ['mcp:invoke'],
    });

    expect(created.plaintext.startsWith('shipit_pat_')).toBe(true);
    expect(created.id).toBe(created.plaintext.slice('shipit_pat_'.length).split('.')[0]);
    expect(created.scopes).toEqual(['mcp:invoke']);
    expect(created.revoked).toBe(false);

    const row = rows.get(created.id)!;
    expect(row).toBeDefined();
    // The plaintext secret must never land in storage.
    expect(row.tokenHash).not.toBe(created.plaintext);
    expect(row.tokenHash.length).toBe(64); // sha256 hex
    expect(row.salt.length).toBeGreaterThan(0);
  });

  it('lowercases the owner email on create and list', async () => {
    await service.create({ name: 't1', ownerEmail: 'Admin@Example.com', scopes: ['mcp:invoke'] });
    const list = await service.listForOwner('admin@example.com');
    expect(list).toHaveLength(1);
    expect(list[0]!.ownerEmail).toBe('admin@example.com');
  });

  it('lists tokens for a single owner, newest first, hiding the secret', async () => {
    const t1 = await service.create({
      name: 'first',
      ownerEmail: 'a@example.com',
      scopes: ['mcp:invoke'],
    });
    // Force a later timestamp for t2.
    rows.get(t1.id)!.createdAt = '2026-01-01T00:00:00.000Z';
    const t2 = await service.create({
      name: 'second',
      ownerEmail: 'a@example.com',
      scopes: ['mcp:invoke'],
    });
    rows.get(t2.id)!.createdAt = '2026-02-01T00:00:00.000Z';

    const list = await service.listForOwner('a@example.com');
    expect(list).toHaveLength(2);
    expect(list[0]!.name).toBe('second');
    expect(list[1]!.name).toBe('first');
    // The metadata interface never exposes plaintext or tokenHash.
    expect((list[0] as unknown as { plaintext?: string }).plaintext).toBeUndefined();
    expect((list[0] as unknown as { tokenHash?: string }).tokenHash).toBeUndefined();
  });

  it('does not list other users tokens', async () => {
    await service.create({ name: 'mine', ownerEmail: 'a@example.com', scopes: ['mcp:invoke'] });
    await service.create({ name: 'theirs', ownerEmail: 'b@example.com', scopes: ['mcp:invoke'] });
    const list = await service.listForOwner('a@example.com');
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe('mine');
  });

  it('validates a fresh token and returns the owner + scopes', async () => {
    const created = await service.create({
      name: 'works',
      ownerEmail: 'admin@example.com',
      scopes: ['mcp:invoke', 'graph:read'],
    });
    const resolved = await service.validate(created.plaintext);
    expect(resolved).toEqual({
      id: created.id,
      ownerEmail: 'admin@example.com',
      scopes: ['mcp:invoke', 'graph:read'],
    });
  });

  it('rejects malformed tokens', async () => {
    expect(await service.validate('not-a-shipit-token')).toBeNull();
    expect(await service.validate('shipit_pat_only-id-no-dot')).toBeNull();
    expect(await service.validate('shipit_pat_.no-id')).toBeNull();
    expect(await service.validate('')).toBeNull();
  });

  it('rejects an unknown token id', async () => {
    expect(await service.validate('shipit_pat_unknownid.anysecret')).toBeNull();
  });

  it('rejects a token whose secret has been tampered with', async () => {
    const created = await service.create({
      name: 'tampered',
      ownerEmail: 'a@example.com',
      scopes: ['mcp:invoke'],
    });
    const match = created.plaintext.match(/^shipit_pat_([^.]+)\.(.+)$/);
    expect(match).not.toBeNull();
    const idPart = match![1];
    const bogus = `shipit_pat_${idPart}.AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKK`;
    expect(await service.validate(bogus)).toBeNull();
  });

  it('rejects a revoked token even with the correct secret', async () => {
    const created = await service.create({
      name: 'will be revoked',
      ownerEmail: 'admin@example.com',
      scopes: ['mcp:invoke'],
    });
    const revoked = await service.revoke(created.id, 'admin@example.com');
    expect(revoked).toBe(true);

    expect(await service.validate(created.plaintext)).toBeNull();
  });

  it('refuses to revoke a token owned by someone else', async () => {
    const created = await service.create({
      name: 'protected',
      ownerEmail: 'a@example.com',
      scopes: ['mcp:invoke'],
    });
    const result = await service.revoke(created.id, 'b@example.com');
    expect(result).toBe(false);
    // Still usable for its real owner.
    const resolved = await service.validate(created.plaintext);
    expect(resolved?.ownerEmail).toBe('a@example.com');
  });
});
