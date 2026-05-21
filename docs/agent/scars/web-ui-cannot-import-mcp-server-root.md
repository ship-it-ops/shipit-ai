---
type: scar
status: active
created: 2026-05-20
updated: 2026-05-20
author: claude-opus-4-7
tags: [web-ui, mcp-server, bundling, turbopack]
importance: core
incident-date: 2026-05-20
tripwire: "if a web-ui import surfaces 'chunking context does not support external modules (request: node:fs)', a transitive import is reaching node-only code — switch to a pure-data subpath."
---

# Web UI imports of workspace package roots can drag node-only code into the bundle

## What Happened

Stage 1 of MCP Access imported `MCP_TOOLS` from `@shipit-ai/mcp-server` (root).
`pnpm typecheck` and `vitest` passed. `next dev` then exploded with:

> Code generation for chunk item errored — the chunking context (unknown) does
> not support external modules (request: node:fs)

Trace:

```
packages/shared/dist/config/find-root.js [Client Component SSR]
packages/shared/dist/config/loader.js   [Client Component SSR]
packages/mcp-server/dist/config.js      [Client Component SSR]
packages/mcp-server/dist/index.js       [Client Component SSR]
packages/web-ui/src/app/configure/mcp/page.tsx
```

The mcp-server root export re-exports `loadConfig` from `./config.js`, which
imports `@shipit-ai/shared`, which uses `node:fs`. Turbopack tried to bundle
all of it for the browser. Typescript was happy because the types didn't
require execution; the runtime bundler is the one that walks the dep graph.

## Tripwire

**If you see a `node:fs` (or any `node:*`) external-module error from a
web-ui-originated import, a transitive import has reached server-only code.**
Don't add it to Next's externals — the fix is upstream: route through a
narrower subpath export.

## Why It Hurt

Build was hard-broken. Stage 1 page would not render. Cost: one round of
"why does typecheck pass but next dev fail?" detective work. Mitigated quickly
because the trace was explicit, but easy to repeat next time someone reaches
for a workspace dep from web-ui.

## Don't Do This

- Don't import from `@shipit-ai/<server-package>` package root in any
  `packages/web-ui/src/**` file. Use a subpath export that points to a
  pure-data module.
- Don't add `node:*` modules to the web UI's externals as a shortcut — that
  papers over the real coupling.
- When designing a new workspace export that any web UI surface might consume,
  put it in its own subpath (`@shipit-ai/<pkg>/<sub>`) backed by a file with
  zero runtime imports.

## Fix Applied

- Added `"./metadata": { "import": "./dist/tools/metadata.js", "types": "./dist/tools/metadata.d.ts" }`
  to `packages/mcp-server/package.json` exports.
- Web UI now imports `MCP_TOOLS` from `@shipit-ai/mcp-server/metadata`.
- The metadata module has zero non-type imports — keep it that way.

## Related

- [mcp-tool-metadata-as-pure-data-module](../decisions/mcp-tool-metadata-as-pure-data-module.md)
