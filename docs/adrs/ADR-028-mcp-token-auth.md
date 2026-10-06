# ADR-028: The MCP Server's HTTP Surface Requires Per-User Tokens

## Status

Accepted (amended 2026-10-05 by ADR-036)

## Date

2026-06-14

## Context

The MCP server's HTTP transport ran every request without an authentication check, while the web UI's MCP page showed "no authentication required". Token minting (`/api/tokens`, stored as `_AccessToken` nodes in Neo4j), the HTTP transport and the Settings → API Keys page already existed; the enforcement did not.

## Decision

- **Shared token crypto** (`splitToken`, `hashSecret`, `constantTimeEqual`, `formatToken`) lives in `@shipit-ai/shared`, so the api-server that mints tokens and the MCP server that checks them share one implementation. A token is `shipit_pat_<id>.<secret>`; only a salted hash of the secret is stored.
- **The MCP server validates the bearer token itself** against the token store through its own Neo4j connection, before the JSON-RPC transport sees the request. Missing or invalid: 401 with `WWW-Authenticate: Bearer`; valid but without the `mcp:invoke` scope: 403. `/health` stays open. The stdio transport stays unauthenticated: it is the operator's own process with the operator's own database credentials.
- The web UI's MCP page reports `authRequired` from `accessControl.auth.enabled` and shows a remote connection snippet with a bearer header.
- **Amendment (ADR-036):** the HTTP entry point hands every tool call the token's owner and scopes; `graph_query` additionally requires the `graph:query` scope, which only an administrator can mint, and counts the owner's calls against a daily budget.

## Consequences

### Positive

- Remote MCP use needs a per-user, revocable token; the per-tool scope seam exists.
- One security-critical hashing implementation.

### Negative

- MCP use does not update a token's `lastUsedAt` (the MCP server reads only).
- `backend.mcp.apiKeySecret` is vestigial and still in the configuration.

### Neutral

- Exposing the MCP server to the internet is an infrastructure decision; the gate ships regardless.

## Alternatives Considered

### Validate through the api-server

- **Cons:** A round trip per request for a check the MCP server can make with the connection it already has.

## References

- `docs/agent/decisions/mcp-token-auth-stage-2a.md`
- `packages/shared/src/auth/token-crypto.ts`, `packages/mcp-server/src/auth.ts`, `docs/mcp-tools.md`
