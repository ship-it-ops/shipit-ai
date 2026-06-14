---
type: decision
status: active
created: 2026-06-14
updated: 2026-06-14
author: claude-session-2026-06-14
tags: [mcp, auth, tokens, security]
importance: core
---

# MCP server enforces per-user token auth on its HTTP surface (Stage 2a)

## Context

`/configure/mcp` showed a green "No authentication required (dev mode)" banner in production.
Root cause: MCP auth enforcement was never built — the mcp-server's HTTP handler ran
`transport.handleRequest()` with NO auth check, and the banner keyed off the
never-enforced `backend.mcp.apiKeySecret`. Stage 2b (HTTP transport), 2c (token
mint/list/revoke `/api/tokens` + Neo4j `_AccessToken` `TokenService`), and 2d (Settings →
API Keys UI) were already built and tested; only the mcp-server enforcement (2a) and the
truthful surfacing were missing.

User decision (2026-06-14): build full Stage 2 — enforce token auth in the mcp-server and
expose it via Ingress.

## Decision

- **Shared token crypto** moved to `@shipit-ai/shared/auth/token-crypto.ts` (`splitToken`,
  `hashSecret`, `constantTimeEqual`, `formatToken`, `TOKEN_PREFIX`). The api-server
  `TokenService` and the mcp-server now share ONE security-critical implementation.
- **mcp-server validates the bearer token directly against Neo4j** (`packages/mcp-server/
src/auth.ts`): the "shared store, lower latency" path — no api-server round-trip, since the
  mcp-server already has a direct Neo4j connection. `authorizeMcpRequest(authHeader, neo4j)`
  returns a decision; `validateMcpToken` does the `_AccessToken` lookup + salted-hash compare.
- **Enforced at the HTTP layer** in `startHttp` (`packages/mcp-server/src/index.ts`), BEFORE
  `transport.handleRequest()` (sidesteps the MCP SDK's lack of a per-tool hook): `/mcp`
  requires `Authorization: Bearer shipit_pat_…` with the `mcp:invoke` scope. Missing/invalid
  → 401 (`WWW-Authenticate: Bearer`); valid-but-under-scoped → 403. `/health` stays open.
  **stdio stays unauthenticated** (local-trust process the operator runs with full Neo4j creds).
- **Surfacing**: `GET /api/mcp/info` `authRequired` now follows
  `accessControl.auth.enabled` (true in prod), NOT `apiKeySecret`. `/configure/mcp` banner
  tells users to mint a token (Settings → API Keys, scope `mcp:invoke`); the connection
  snippet is now a remote `mcp-remote` config pointing at `<origin>/mcp` with a Bearer header,
  replacing the old local stdio command that embedded raw Neo4j creds.

## Consequences

- Remote MCP requires a per-user, revocable token in production; read-only Neo4j session in
  the mcp-server means MCP usage does NOT bump `lastUsedAt` (minor; follow-up could add a
  write session).
- `backend.mcp.apiKeySecret` is now vestigial (no longer the auth signal); left in config.
- **Requires infra** to actually expose the mcp-server (see
  `docs/agent/briefs/infra-mcp-server-deploy.md`). App ships independently; without exposure
  the gate simply isn't reachable.

## Revisit Triggers

- Per-tool scope granularity needed (e.g. `graph:read` vs `catalog:read`) → move the scope
  check from the HTTP layer into per-tool guards.
- `lastUsedAt` for MCP tokens matters → give the mcp-server a write session for the touch.

## Related

- [mcp-access-stage-2-real-login](../plans/mcp-access-stage-2-real-login.md) — the plan this completes (2a)
- [auth-oauth-app-separate-from-connector](./auth-oauth-app-separate-from-connector.md) — same session; login auth posture that `authRequired` now follows
