# ADR-022: Claude Code Plugin in the Monorepo; Tool Metadata as a Pure Data Module

## Status

Accepted

## Date

2026-05-21

## Context

Connecting an agent to the MCP server by hand means pasting JSON and editing a path, and the agent still knows nothing about when to use `blast_radius` rather than `graph_query`, what a canonical id looks like, or how to read the response envelope. The web UI's MCP page also needs the same tool descriptions the server sends to agents, and two copies would drift.

## Decision

- A Claude Code plugin lives in this repository at `plugin/`: a manifest, an `.mcp.json` that registers the server over HTTP (`SHIPIT_MCP_URL`, default `http://localhost:3002/mcp`), and three skills under `plugin/skills/` (`shipit-graph`, `shipit-cypher`, `shipit-debugging`) that route an agent to the right tool, describe the Cypher guardrails and map error codes to recovery. The skills version-lock to the tools they describe.
- All tool metadata (name, description, parameters, documentation anchor, effect, whether agents may be offered it) lives in `packages/mcp-server/src/tools/metadata.ts`, a module with no runtime imports, exported as `@shipit-ai/mcp-server/metadata`. Each tool's `register*` function reads its description from it; the web UI and the api-server import the same module.

## Consequences

### Positive

- One install registers the server and teaches the agent.
- The server, the UI and the plugin describe each tool from one source.

### Negative

- Adding a tool touches three places: the register function, the metadata module and, usually, the `shipit-graph` skill's routing table.

### Neutral

- Skills route; `docs/mcp-tools.md` is the reference. A skill that grows into a reference card belongs in `docs/`.

## Alternatives Considered

### A separate plugin repository

- **Cons:** Nothing to put there but a manifest and skills; version coordination for no gain.

### An npm CLI that writes the client config

- **Cons:** Solves only the JSON-editing step; gives the agent no guidance.

## References

- `docs/agent/decisions/claude-code-plugin-in-monorepo-with-skills.md`, `mcp-tool-metadata-as-pure-data-module.md`
- `plugin/README.md`, `docs/mcp-tools.md`
