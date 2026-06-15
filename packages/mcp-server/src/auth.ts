// Per-user token validation for the MCP server's network (HTTP) surface.
//
// Tokens are minted + stored by the api-server as Neo4j `_AccessToken` nodes
// (salted SHA-256 of the secret). The mcp-server validates a presented bearer
// token against that SAME store using its own direct Neo4j connection — the
// lower-latency "shared store" path, no api-server round-trip. The crypto
// primitives are shared via @shipit-ai/shared so hashing/compare has one
// implementation across both servers.
//
// Read-only by design: unlike the api-server's TokenService this does NOT bump
// `lastUsedAt` (the mcp-server's Neo4j session is read-only). Acceptable for
// v1; a follow-up could add a write session for the touch.
import { splitToken, hashSecret, constantTimeEqual } from '@shipit-ai/shared';
import type { Neo4jClient } from './neo4j-client.js';

// Scope a token must carry to invoke MCP tools over the network.
export const MCP_INVOKE_SCOPE = 'mcp:invoke';

export interface ValidatedMcpToken {
  ownerEmail: string;
  scopes: string[];
}

/**
 * Validate a `shipit_pat_<id>.<secret>` bearer token against the Neo4j
 * `_AccessToken` store. Returns the owner + scopes on success, or `null` on
 * any failure (malformed, unknown id, revoked, wrong secret).
 */
export async function validateMcpToken(
  neo4j: Neo4jClient,
  plaintext: string,
): Promise<ValidatedMcpToken | null> {
  const parts = splitToken(plaintext);
  if (!parts) return null;

  const result = await neo4j.runCypher(`MATCH (t:_AccessToken { id: $id }) RETURN t`, {
    id: parts.id,
  });
  const record = result.records[0];
  if (!record) return null;

  const props = (record.get('t') as { properties: Record<string, unknown> }).properties;
  if (props.revoked === true) return null;

  const expectedHash = typeof props.tokenHash === 'string' ? props.tokenHash : '';
  const salt = typeof props.salt === 'string' ? props.salt : '';
  if (!constantTimeEqual(hashSecret(parts.secret, salt), expectedHash)) return null;

  return {
    ownerEmail: String(props.ownerEmail ?? ''),
    scopes: Array.isArray(props.scopes) ? (props.scopes as string[]) : [],
  };
}

export type McpAuthDecision =
  | { ok: true; token: ValidatedMcpToken }
  | { ok: false; status: 401 | 403; code: string; message: string };

/**
 * Decide whether an MCP HTTP request is authorized. Pure of any HTTP I/O so it
 * can be unit-tested across every branch: missing/malformed header (401),
 * invalid/revoked token (401), valid token without `mcp:invoke` (403), or OK.
 */
export async function authorizeMcpRequest(
  authorization: string | undefined,
  neo4j: Neo4jClient,
): Promise<McpAuthDecision> {
  const bearer =
    typeof authorization === 'string' && authorization.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : null;
  if (!bearer) {
    return {
      ok: false,
      status: 401,
      code: 'MISSING_TOKEN',
      message: 'A Bearer token is required. Mint one under Settings → API Keys.',
    };
  }
  const token = await validateMcpToken(neo4j, bearer);
  if (!token) {
    return {
      ok: false,
      status: 401,
      code: 'INVALID_TOKEN',
      message: 'Bearer token is invalid, revoked, or expired.',
    };
  }
  if (!token.scopes.includes(MCP_INVOKE_SCOPE)) {
    return {
      ok: false,
      status: 403,
      code: 'INSUFFICIENT_SCOPE',
      message: `Token is missing the '${MCP_INVOKE_SCOPE}' scope.`,
    };
  }
  return { ok: true, token };
}
