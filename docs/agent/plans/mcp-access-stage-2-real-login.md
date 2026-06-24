---
type: plan
status: completed
created: 2026-05-20
updated: 2026-06-23
author: claude-opus-4-7
tags: [mcp, auth, http-transport, tokens]
importance: standard
---

# MCP Access Stage 2 — real login (remote transport + tokens)

> **Status 2026-06-14:** 2b (HTTP transport), 2c (token API + Neo4j `_AccessToken`
> TokenService), 2d (Settings → API Keys UI), and **2a (mcp-server bearer enforcement)** are
> all implemented + tested app-side. Token crypto is shared via
> `@shipit-ai/shared/auth/token-crypto`. See
> [mcp-token-auth-stage-2a](../decisions/mcp-token-auth-stage-2a.md). Remaining: **deploy +
> expose the mcp-server** (infra brief `briefs/infra-mcp-server-deploy.md`).

## Goal

Today the MCP server is stdio-only and `backend.mcp.apiKeySecret` is wired in
config but never enforced. Stage 2 makes "log in to MCP" a real flow: a user
mints a token in the web UI, pastes it into an MCP client, and connects to a
remote MCP endpoint that validates the token.

Stage 1 (`/configure/mcp` page + tool metadata seam) is complete and unblocks
Stage 2 — the page already toggles its auth-status banner off
`GET /api/mcp/info`, and the tool catalog flows from the metadata seam.

## Approach

Sequenced because each step gates the next.

**2a. Enforce `apiKeySecret` in `mcp-server`**

- `packages/mcp-server/src/server.ts` — guard tool calls when `apiKeySecret` is set.
  Reject calls whose authorization metadata doesn't match.
- Tests in `packages/mcp-server/src/__tests__/` covering pass/fail/no-auth paths.
- Works for stdio too once a header/metadata field is wired.

**2b. Streamable HTTP transport alongside stdio**

- `packages/mcp-server/src/index.ts` — branch on `MCP_TRANSPORT` env
  (`stdio` default, `http` for remote). Use
  `StreamableHTTPServerTransport` from `@modelcontextprotocol/sdk/server/streamableHttp.js`.
- Default port `MCP_HTTP_PORT=3002` (api-server owns 3001, web-ui owns 3000).
- Auth header: `Authorization: Bearer <token>` validated via the 2a guard.
- Update `packages/mcp-server/Dockerfile` to expose the port; update
  `docs/deployment.md` env-var table.

**2c. Token mint/list/revoke in `api-server`**

- New file: `packages/api-server/src/routes/tokens.ts`.
  - `POST /api/tokens` → returns plaintext **once**; persists only the hash.
  - `GET /api/tokens` → list metadata (no plaintext).
  - `DELETE /api/tokens/:id` → revoke.
- Storage: extend the existing services layer. Schema: `id`, `nameHash`,
  `tokenHash` (sha256 + per-row salt), `createdAt`, `lastUsedAt`, `scopes`.
- Validation seam: `mcp-server` looks up token hashes in the same store
  (recommended for v1 — lower latency) OR calls
  `POST /internal/tokens/validate` on `api-server` (cleaner boundary).
  Pick during implementation; the lookup function is the only thing that
  needs to change between the two.

**2d. Settings → API Keys UI**

- Replace the EmptyState in `packages/web-ui/src/app/settings/page.tsx` with:
  - Table of existing tokens (name, created, lastUsedAt, revoke button).
  - "Create token" modal showing the token plaintext once with a copy +
    "I've saved it" confirm flow.
  - Cross-link to `/configure/mcp` for the actual paste step.
- The `/configure/mcp` JSON snippets gain a placeholder for
  `Authorization: Bearer <YOUR_TOKEN>` once auth is required.
- `packages/web-ui/src/components/onboarding/onboarding-dialog.tsx` —
  add a "Generate your first MCP token" step.

## Files to Touch

| Stage | File                                                              | Action                               |
| ----- | ----------------------------------------------------------------- | ------------------------------------ |
| 2a    | `packages/mcp-server/src/server.ts`                               | enforce `apiKeySecret`               |
| 2b    | `packages/mcp-server/src/index.ts`                                | add Streamable HTTP transport branch |
| 2b    | `packages/mcp-server/Dockerfile`, `docs/deployment.md`            | port + env                           |
| 2c    | `packages/api-server/src/routes/tokens.ts`                        | **create** CRUD endpoints            |
| 2c    | `packages/api-server/src/services/`                               | token store                          |
| 2d    | `packages/web-ui/src/app/settings/page.tsx`                       | real API Keys UI                     |
| 2d    | `packages/web-ui/src/components/onboarding/onboarding-dialog.tsx` | token-generation step                |

## Status

- **2b (Streamable HTTP transport) shipped early on 2026-05-21** to unblock
  the Claude Code plugin (`plugin/.mcp.json`) — the plugin now connects via
  HTTP at `http://localhost:3002/mcp` rather than spawning the server over
  stdio. Stateless mode, single transport, smoke-tested with a real
  `initialize` call. See `packages/mcp-server/src/index.ts` `startHttp()`.
- **2a (apiKeySecret enforcement)**, **2c (token mint/list/revoke)**, and
  **2d (Settings → API Keys UI)** not started. Until they ship, the HTTP
  endpoint is unauthenticated — fine for `localhost` only.
- Stage 1 (`/configure/mcp`, tool metadata seam, `/api/mcp/info`) is shipped
  and verified — typecheck + tests green across web-ui, api-server, and
  mcp-server.

Token ownership in 2c piggybacks on `useCurrentUser()` (the dev-user
override) until real auth lands. That's a known seam, not a blocker.

## Related

- [mcp-tool-metadata-as-pure-data-module](../decisions/mcp-tool-metadata-as-pure-data-module.md)
- [web-ui-cannot-import-mcp-server-root](../scars/web-ui-cannot-import-mcp-server-root.md)
