import { describe, it, expect } from 'vitest';
import { hashSecret, formatToken } from '@shipit-ai/shared';
import { authorizeMcpRequest, validateMcpToken } from '../auth.js';
import { createMockNeo4jClient, createMockRecord } from './helpers/mock-neo4j.js';

// Build a Neo4j client that returns a single `_AccessToken` row with the
// given properties for any token-lookup query. Untyped Map mirrors the other
// mcp-server tests (the mock records are structural stand-ins for neo4j rows).
function clientWithToken(props: Record<string, unknown>) {
  const responses = new Map();
  responses.set('_AccessToken', {
    records: [createMockRecord({ t: { properties: props } })],
    summary: { resultAvailableAfter: 0 },
  });
  return createMockNeo4jClient(responses);
}

const ID = 'abc123def456';
const SECRET = 'super-secret-value';
const SALT = 'random-salt-bytes';
const GOOD_TOKEN = formatToken(ID, SECRET);

function validRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ID,
    tokenHash: hashSecret(SECRET, SALT),
    salt: SALT,
    ownerEmail: 'user@example.com',
    scopes: ['mcp:invoke', 'graph:read'],
    revoked: false,
    ...overrides,
  };
}

describe('validateMcpToken', () => {
  it('returns owner + scopes for a valid token', async () => {
    const res = await validateMcpToken(clientWithToken(validRow()), GOOD_TOKEN);
    expect(res).toEqual({ ownerEmail: 'user@example.com', scopes: ['mcp:invoke', 'graph:read'] });
  });

  it('returns null for a malformed token (no prefix)', async () => {
    expect(await validateMcpToken(clientWithToken(validRow()), 'not-a-token')).toBeNull();
  });

  it('returns null when the id is unknown (no row)', async () => {
    expect(await validateMcpToken(createMockNeo4jClient(), GOOD_TOKEN)).toBeNull();
  });

  it('returns null for a revoked token even with the right secret', async () => {
    expect(
      await validateMcpToken(clientWithToken(validRow({ revoked: true })), GOOD_TOKEN),
    ).toBeNull();
  });

  it('returns null when the secret hash does not match', async () => {
    const wrong = formatToken(ID, 'wrong-secret');
    expect(await validateMcpToken(clientWithToken(validRow()), wrong)).toBeNull();
  });
});

describe('authorizeMcpRequest', () => {
  it('authorizes a valid token carrying mcp:invoke', async () => {
    const decision = await authorizeMcpRequest(`Bearer ${GOOD_TOKEN}`, clientWithToken(validRow()));
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.token.ownerEmail).toBe('user@example.com');
  });

  it('401 MISSING_TOKEN when no Authorization header', async () => {
    const decision = await authorizeMcpRequest(undefined, clientWithToken(validRow()));
    expect(decision).toMatchObject({ ok: false, status: 401, code: 'MISSING_TOKEN' });
  });

  it('401 MISSING_TOKEN when the scheme is not Bearer', async () => {
    const decision = await authorizeMcpRequest(`Basic ${GOOD_TOKEN}`, clientWithToken(validRow()));
    expect(decision).toMatchObject({ ok: false, status: 401, code: 'MISSING_TOKEN' });
  });

  it('401 INVALID_TOKEN for an unknown/revoked/bad token', async () => {
    const decision = await authorizeMcpRequest(`Bearer ${GOOD_TOKEN}`, createMockNeo4jClient());
    expect(decision).toMatchObject({ ok: false, status: 401, code: 'INVALID_TOKEN' });
  });

  it('403 INSUFFICIENT_SCOPE when the token lacks mcp:invoke', async () => {
    const decision = await authorizeMcpRequest(
      `Bearer ${GOOD_TOKEN}`,
      clientWithToken(validRow({ scopes: ['graph:read'] })),
    );
    expect(decision).toMatchObject({ ok: false, status: 403, code: 'INSUFFICIENT_SCOPE' });
  });
});
