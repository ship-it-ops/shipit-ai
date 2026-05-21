---
type: scar
status: active
created: 2026-05-21
updated: 2026-05-21
author: claude-opus-4-7
tags: [claude-code, mcp, plugin, env-vars]
importance: core
incident-date: 2026-05-21
tripwire: 'if you write `cwd: ...` in any `.mcp.json` and expect the server to start there, stop — Claude Code ignores that field. Use env vars + absolute paths.'
---

# Claude Code ignores `cwd` in `.mcp.json` — use env vars instead

## What Happened

While building the `plugin/.mcp.json` for the in-repo Claude Code plugin,
the first draft used the same JSON shape we publish on the `/configure/mcp`
web page:

```json
{
  "command": "node",
  "args": ["packages/mcp-server/dist/index.js"],
  "cwd": "/path/to/ShipIt-AI",
  "env": { "NEO4J_URI": "..." }
}
```

That shape works for Claude Desktop and Cursor (they honour `cwd`).
**Claude Code does not** — it always starts the server in the directory
where the `claude` CLI was launched, so a relative `args` path resolves
against the user's current shell directory instead of the ShipIt-AI repo.
Tracked upstream as
[anthropics/claude-code#17565](https://github.com/anthropics/claude-code/issues/17565).

The MCP server also walks up from CWD looking for `shipit.config.yaml`
(`packages/shared/src/config/find-root.ts`), so the ignored `cwd`
double-breaks it: wrong binary path _and_ wrong config search root.

## Tripwire

**If you write `cwd:` in any `.mcp.json` shipped via a Claude Code plugin,
stop — Claude Code silently ignores it.** Don't argue with the field name;
it does not work. Two non-negotiables:

1. Use **absolute paths** in `args` (via env-var interpolation).
2. Use the server's own env-var overrides (`SHIPIT_CONFIG`,
   `SHIPIT_AI_HOME`) to point at config and binaries, not CWD-relative
   conventions.

## Why It Hurt

A test install would have produced a confusing `Cannot find module
packages/mcp-server/dist/index.js` error from wherever the user ran
`claude`, with no hint that `cwd` was being dropped. Would have looked like
a broken plugin and burned debugging cycles.

## Don't Do This

- Don't copy the `claude_desktop_config.json` snippet verbatim into a
  Claude Code plugin's `.mcp.json` — drop the `cwd` field and rewrite
  `args` to an absolute path.
- Don't rely on relative paths in `args`. The user's shell directory is not
  the plugin install directory.
- Don't bake the user's home directory into the plugin — require an env var
  (`SHIPIT_AI_HOME`) that they export in their shell rc. Document it
  loudly in the README.

## Fix Applied

We sidestepped the problem entirely by switching the plugin from stdio to
HTTP transport (2026-05-21). The MCP server now exposes a Streamable HTTP
endpoint on `http://localhost:3002/mcp`, and `plugin/.mcp.json` is just:

```json
{
  "mcpServers": {
    "shipit-ai": {
      "type": "http",
      "url": "${SHIPIT_MCP_URL:-http://localhost:3002/mcp}"
    }
  }
}
```

No `cwd`, no binary paths, no env-var dance. The scar still stands for any
future stdio-mode plugin — Claude Code's `cwd` handling has not changed.

## Related

- [claude-code-plugin-in-monorepo-with-skills](../decisions/claude-code-plugin-in-monorepo-with-skills.md)
- [mcp-access-stage-2-real-login](../plans/mcp-access-stage-2-real-login.md) — when HTTP transport ships, this scar is moot for remote installs but still applies to anyone running stdio locally
