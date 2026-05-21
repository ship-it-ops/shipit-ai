---
type: decision
status: active
created: 2026-05-21
updated: 2026-05-21
author: claude-opus-4-7
tags: [mcp, claude-code, plugin, skills, packaging]
importance: core
---

# Claude Code plugin lives in this monorepo and ships skills, not a separate repo or npm CLI

## Context

Stage 1 of MCP Access (the `/configure/mcp` page) reduced "connect a Claude
Code agent to the ShipIt-AI MCP server" to "copy-paste JSON, edit a path".
That's still friction. The real goal: a one-command install that registers
the server **and** teaches the agent how to use the 8 graph tools well —
when to reach for `blast_radius` vs. `graph_query`, the canonical-ID format,
the response envelope, error-recovery patterns.

Three distribution shapes were considered before landing on this one.

## Decision

Ship a **Claude Code plugin in this repo at `plugin/`**, with three skills
under `plugin/skills/` (`shipit-graph`, `shipit-cypher`, `shipit-debugging`)
and the MCP server registered via `plugin/.mcp.json`.

- The plugin manifest lives at `plugin/.claude-plugin/plugin.json` per the
  current Claude Code plugin schema.
- The MCP server registration is in `plugin/.mcp.json` and connects to the
  server over **HTTP** at `${SHIPIT_MCP_URL:-http://localhost:3002/mcp}`.
  No local binary path or stdio handshake — the dev stack runs the server
  as a long-lived HTTP process. Future remote deployments override
  `SHIPIT_MCP_URL`.
- Skills are markdown with `description:` frontmatter and live at
  `plugin/skills/<name>/SKILL.md`.

## Alternatives Considered

- **Separate repo `shipit-ai-plugin`**: rejected once we realized the
  plugin holds nothing but a manifest + skills + a pointer to this repo's
  server. Two repos to maintain, plus a version-coordination problem, for
  no extra functionality. The skills should version-lock to the tool
  metadata they describe.
- **npm CLI (`npx shipit-mcp init`) that writes the JSON config**: rejected
  earlier in the design conversation — a CLI solves only the "edit JSON for
  me" problem and gives the agent no extra guidance. A plugin install does
  both natively for Claude Code users.
- **No plugin; just keep `/configure/mcp` as the connection path**:
  rejected because the in-app page only solves the connection step; it can't
  inject context into the agent's session. Skills are the missing piece.

## Consequences

- One install command (`claude plugin install --plugin-dir
"$SHIPIT_AI_HOME/plugin"` today, full marketplace install once subpath
  installs ship) covers both server registration and agent guidance.
- Adding a new MCP tool now has three coordinated touchpoints to keep
  in sync: the tool's `register*` function, the metadata at
  `packages/mcp-server/src/tools/metadata.ts`, and (likely) the
  `shipit-graph` skill's decision table. The metadata is enforced by code;
  the skill update is a manual reminder — call it out in PRs that change
  the tool catalog.
- The plugin must not duplicate tool documentation that lives in
  `docs/mcp-tools.md`. Skills should _route_ to the right tool, not
  reproduce its full param reference. If a skill grows to be a reference
  card, move that content to `docs/` and link from the skill.

## Revisit Triggers

- When Stage 2 ships HTTP transport + per-user tokens, the plugin will
  gain a remote connection mode. The skills shouldn't need to change —
  they're transport-agnostic — but `.mcp.json` will.
- If Claude Code adds first-class subpath plugin installs, drop the
  `--plugin-dir` workaround from the README install instructions.
- If we ever want to publish the plugin to a non-Claude-Code MCP client
  marketplace (e.g. Cursor), we'd split it out — but no demand today.

## Related

- [mcp-tool-metadata-as-pure-data-module](mcp-tool-metadata-as-pure-data-module.md)
  — the metadata seam the skills lean on.
- [claude-code-mcp-cwd-field-ignored](../scars/claude-code-mcp-cwd-field-ignored.md)
  — why the plugin uses `SHIPIT_AI_HOME` env var instead of `cwd`.
- [mcp-access-stage-2-real-login](../plans/mcp-access-stage-2-real-login.md)
  — what changes in the plugin when Stage 2 lands.
