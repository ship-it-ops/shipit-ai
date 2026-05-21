---
type: decision
status: active
created: 2026-05-20
updated: 2026-05-20
author: claude-opus-4-7
tags: [mcp, metadata, web-ui, packaging]
importance: core
---

# MCP tool descriptions live in metadata.ts, not in each register\* function

## Context

Before Stage 1 of MCP Access, each tool's display name and description was a
literal string passed as `server.tool('blast_radius', 'Analyze…', ...)` inside
its own file under `packages/mcp-server/src/tools/`. The web UI at
`/configure/mcp` needs to render the same descriptions in tool cards. Two
sources of truth would drift — a tool author updates the description for the
agent and forgets the UI copy, or vice versa.

## Decision

- All tool metadata (name, description, params, doc anchor) lives in
  `packages/mcp-server/src/tools/metadata.ts` as a frozen array of pure data.
- Each `register*` function reads its description via `MCP_TOOL_BY_NAME.<name>.description`.
- The metadata module is re-exported via a dedicated subpath:
  `@shipit-ai/mcp-server/metadata`. Web UI imports from there; the package
  root export still includes it for Node consumers (api-server).

## Alternatives Considered

- **Keep strings in each tool file, duplicate in a UI-side list**: rejected —
  guaranteed drift; no enforcement.
- **Move metadata to `@shipit-ai/shared`**: rejected — shared is for cross-cutting
  types/utilities; tool metadata is owned by the MCP server.
- **Have web UI import from the package root (`@shipit-ai/mcp-server`)**: tried
  and broke the bundle (see [web-ui-cannot-import-mcp-server-root](../scars/web-ui-cannot-import-mcp-server-root.md)).
  Subpath export sidesteps it.

## Consequences

- Adding a new MCP tool requires editing both `metadata.ts` and the tool's
  register file. Forgetting the metadata entry won't break the build but the
  UI will not list the tool and `server.tool()` will get an `undefined` description.
- Param descriptions still live in zod `.describe(...)` calls — only the
  top-level tool description is hoisted. Params for the UI are duplicated
  (deliberately, since the zod-derived shapes don't map cleanly to a flat list).
- The metadata module has **zero non-type imports**. Keep it that way — any
  runtime import would re-poison the bundle for the web UI.

## Revisit Triggers

- If we add many more tools and the duplication of param shapes becomes
  painful, consider deriving the UI params from the zod schema instead.
- If the MCP server gains a second consumer (CLI, plugin) that needs richer
  metadata (e.g. example invocations), expand the schema in `metadata.ts`.

## Related

- [web-ui-cannot-import-mcp-server-root](../scars/web-ui-cannot-import-mcp-server-root.md) — why the subpath export is non-negotiable
- [mcp-access-stage-2-real-login](../plans/mcp-access-stage-2-real-login.md) — Stage 2 builds on this metadata seam
