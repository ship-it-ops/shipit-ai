import { describe, it, expect } from 'vitest';
import { buildLoginPersonEntity, type LoginIdentity } from '../../services/person-upsert.js';

const FIXED_NOW = new Date('2026-06-14T09:30:00.000Z');

describe('buildLoginPersonEntity — GitHub login', () => {
  const identity: LoginIdentity = {
    provider: 'github',
    sub: '12345',
    displayName: 'Ada Lovelace',
    email: 'ada@example.com',
    login: 'GH-User',
  };

  it('keys the Person by the lowercased GitHub login (merges with the connector Person)', () => {
    const { nodes } = buildLoginPersonEntity(identity, FIXED_NOW);
    expect(nodes).toHaveLength(1);
    // IDENTICAL to the connector's buildPersonCanonicalId(login) (login
    // 'GH-User' → '…/gh-user') — this shared lowercasing is what makes the
    // core-writer merge instead of duplicate.
    expect(nodes[0].id).toBe('shipit://person/default/gh-user');
    expect(nodes[0].label).toBe('Person');
  });

  it('emits name/email/login claims sourced as login at confidence 0.85', () => {
    const { nodes } = buildLoginPersonEntity(identity, FIXED_NOW);
    const claims = nodes[0]._claims;
    const byKey = Object.fromEntries(claims.map((c) => [c.property_key, c]));
    expect(Object.keys(byKey).sort()).toEqual(['email', 'login', 'name']);
    for (const c of claims) {
      expect(c.source).toBe('login');
      expect(c.confidence).toBe(0.85);
      expect(c.source_id).toBe('idp://github/12345');
      expect(c.ingested_at).toBe(FIXED_NOW.toISOString());
    }
    expect(byKey.name.value).toBe('Ada Lovelace');
    expect(byKey.email.value).toBe('ada@example.com');
    // login claim preserves the original casing as the value; only the
    // canonical id is lowercased.
    expect(byKey.login.value).toBe('GH-User');
  });

  it('sets login provenance and a date-bucket event version, no edges', () => {
    const { nodes, edges } = buildLoginPersonEntity(identity, FIXED_NOW);
    expect(nodes[0]._source_system).toBe('login');
    expect(nodes[0]._source_org).toBe('login');
    expect(nodes[0]._source_id).toBe('idp://github/12345');
    expect(nodes[0]._event_version).toBe('2026-06-14');
    expect(edges).toEqual([]);
  });

  it('mirrors name/email/login into top-level properties', () => {
    const { nodes } = buildLoginPersonEntity(identity, FIXED_NOW);
    expect(nodes[0].properties).toEqual({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      login: 'GH-User',
    });
  });
});

describe('buildLoginPersonEntity — OIDC login (no GitHub login)', () => {
  const identity: LoginIdentity = {
    provider: 'oidc',
    sub: 'auth0|abc',
    displayName: 'Grace Hopper',
    email: 'Grace@Example.com',
    // no login
  };

  it('keys by the lowercased email (best-effort; will not merge with connector Persons)', () => {
    const { nodes } = buildLoginPersonEntity(identity, FIXED_NOW);
    expect(nodes[0].id).toBe('shipit://person/default/grace@example.com');
  });

  it('emits only name + email claims (no login claim) with an idp/oidc linking key', () => {
    const { nodes } = buildLoginPersonEntity(identity, FIXED_NOW);
    const keys = nodes[0]._claims.map((c) => c.property_key).sort();
    expect(keys).toEqual(['email', 'name']);
    expect(nodes[0]._source_id).toBe('idp://oidc/auth0|abc');
    expect(nodes[0].properties).toEqual({
      name: 'Grace Hopper',
      email: 'Grace@Example.com',
    });
  });
});
