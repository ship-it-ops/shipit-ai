---
type: status
status: completed
created: 2026-10-06
updated: 2026-10-06
author: claude-session-2026-10-06-docs-refresh
branch: docs-refresh-2026-10
agent: claude-session-2026-10-06-docs-refresh
tags: [docs, adrs, readme, api-reference]
importance: standard
---

# Documentation refresh: README, every `docs/*.md`, the plugin README, 19 new ADRs

**Completed 2026-10-06:** pull request #133 merged into `main` as `da862c9` (CI green, automated
review LGTM with no findings). Archived by the same session.

Cut from `main` after #132 (`00a3d42`). Brings the user-facing docs up to what shipped since
May: sign-in and tokens, setup mode, GSM secrets, the webhook receiver, the Kubernetes
connector, the agent platform, the knowledge layer, the raw-Cypher guard, GKE hosting. ADRs
018–036 record the decisions that only lived in `docs/agent/decisions/`.

## Scope

- Rewritten: `README.md`, `docs/getting-started.md`, `docs/architecture.md`,
  `docs/api-reference.md` (from a route-by-route inventory of `packages/api-server/src/routes`),
  `docs/deployment.md`, `docs/connectors.md`, `docs/connectors/github-setup.md`,
  `docs/schema-guide.md`, `plugin/README.md`; corrected: `docs/local-development.md`,
  `docs/mcp-tools.md`.
- New: `docs/adrs/ADR-018` … `ADR-036`, `SECURITY.md`; ADR-005 and ADR-009 marked superseded.
- Two non-doc changes made so the docs could be true: `plugin/.mcp.json` sends
  `Authorization: Bearer ${SHIPIT_MCP_TOKEN:-}` (the HTTP transport requires a token);
  `docker/docker-compose.yml` passes `NEO4J_USER`, `SHIPIT_API_URL` and `SHIPIT_WEB_ORIGIN` to
  `api-server`, `core-writer` and `mcp-server` (the committed config has no fallback for them,
  so those three services could not boot — verified with the shared loader).
- Product gaps the audit surfaced are in
  [docs-refresh-2026-10-findings](../open-questions/docs-refresh-2026-10-findings.md).

## Why

The owner asked on 2026-10-06: "create a docs branch and update all the docs - readmes, ADRs
etc with everything needed".

## Done when

The pull request for this branch is merged:
`gh pr list --head docs-refresh-2026-10 --state merged --json number -q length` prints `1`.
