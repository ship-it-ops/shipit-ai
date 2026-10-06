---
type: open-question
status: active
created: 2026-10-06
updated: 2026-10-06
author: claude-session-2026-10-06-docs-refresh
tags: [docs, auth, tokens, schema, compose, plugin]
importance: standard
---

# Gaps the 2026-10 documentation audit found — which are intended?

Checking every user-facing doc against the code (five read-only audits plus a route inventory)
turned up behaviour that the docs now describe as it is, but that the owner may not have
intended. Each needs a decision; none was changed in the docs branch.

## Questions

1. **A `member` cannot mint an MCP token.** `POST /api/tokens` refuses any scope the caller
   lacks, and `capabilitiesForRole('member')` (`packages/api-server/src/routes/auth.ts`) holds
   `graph:read`, `catalog:read`, `graph:write`, `agents:read`, `agents:run` — not
   `mcp:invoke`. So only administrators can mint a usable MCP token; a member who opens
   Settings → API Keys gets `403 SCOPE_OUT_OF_REACH` for the default scope. Intended, or should
   `mcp:invoke` join the member set?
2. **`/api/schema` is not role-gated.** Any signed-in principal, bearer tokens included, can
   `PUT` the schema and `POST /rollback` (the route file says "Phase 3 RBAC will gate this").
   Is it time for `requireAdmin`, or a `schema:edit` capability (the dev user's example config
   already lists one)?
3. **`POST …/verify` and `POST /api/claims/review/resolve` have no capability gate** either —
   same question.
4. **`mode: simple` is accepted by the schema validator but nothing reads it**; ADR-011
   describes a collapsed `Service` node that was never built. Keep the field for the plan, or
   drop it from the validator until it does something?
5. **ADR-009 said the schema lives in Neo4j as meta-nodes; it lives in a YAML file.** The ADR
   now carries a superseded note; it may deserve its own replacement ADR.
6. **`entities.{environment,deployment,branchProtection,workflowRun}`** on a GitHub connector
   instance are accepted and ignored; the connector emits four entity types. Reserved on
   purpose, or remove until implemented?
7. **The compose stack's `api-server`, `core-writer` and `mcp-server` could not boot** on
   `main`: the mounted `shipit.config.yaml` requires `NEO4J_USER`, `SHIPIT_API_URL` and
   `SHIPIT_WEB_ORIGIN` with no fallback and the services did not receive them (the two
   worker services did, with a comment saying why). The docs branch adds them; nothing in CI
   starts the compose stack, which is why it went unnoticed. Worth a smoke job?
8. **The Claude Code plugin shipped without an `Authorization` header** while the MCP HTTP
   transport has required a token since June. The docs branch adds
   `Bearer ${SHIPIT_MCP_TOKEN:-}` to `plugin/.mcp.json` — an empty token still answers
   `401 MISSING_TOKEN`, so nothing regresses — and documents that locally (sign-in off, no
   tokens) stdio is the path. Should the plugin register a stdio entry as well?
9. **`GET /api/connectors/:id` (and `/runs`, `/status`) answer 404 with code `INTERNAL_ERROR`**
   for an unknown id: the registry throws with `statusCode: 404` but no `code`, and those
   handlers do not catch (PATCH/DELETE map it to `NOT_FOUND`). Cosmetic; the reference says
   `404`.

## Who can answer

The owner. Items 1–3 are access-model decisions ([ADR-027](../../adrs/ADR-027-login-and-access-model.md),
[ADR-028](../../adrs/ADR-028-mcp-token-auth.md)); 4–6 are schema and connector scope; 7–9 are
small fixes once decided.

## Related

- [docs-refresh-2026-10](../status/docs-refresh-2026-10.md)
- [mcp-token-auth-stage-2a](../decisions/mcp-token-auth-stage-2a.md)
- [raw-cypher-read-only-guard](../decisions/raw-cypher-read-only-guard.md)
