# ShipIt-AI Claude Code Plugin

Connects [Claude Code](https://docs.claude.com/en/docs/claude-code) to the
ShipIt-AI knowledge graph over **HTTP**. Installing this plugin:

1. Registers the ShipIt-AI MCP server as an HTTP endpoint so the 8 read-only
   graph tools become available in any Claude Code session.
2. Loads three skills (`shipit-graph`, `shipit-cypher`, `shipit-debugging`)
   that teach the agent how to use the tools well — picking the right one
   for a question, writing safe Cypher, and recovering from errors.

The plugin lives in the same repo as the server so its version is always
locked to the server it configures.

## How it talks to the server

The plugin's `.mcp.json` registers a Streamable-HTTP MCP server pointing at:

```
${SHIPIT_MCP_URL:-http://localhost:3002/mcp}
```

- **Local dev (default):** the dev stack starts the MCP server on
  `http://localhost:3002/mcp`. Just run `pnpm dev` (or `pnpm start:all`)
  in the ShipIt-AI repo — no env var needed.
- **Remote / hosted:** export `SHIPIT_MCP_URL` to your deployed endpoint
  before launching Claude Code:
  ```sh
  export SHIPIT_MCP_URL="https://shipit.your-company.com/mcp"
  ```

## Requirements

- Node 22+ (only the dev stack — Claude Code itself runs the plugin via HTTP).
- The ShipIt-AI dev stack running locally **or** a reachable remote
  deployment.

## Install

The plugin lives in the `plugin/` subdirectory of the ShipIt-AI repo. Today,
Claude Code's marketplace install path expects plugins at the repo root, so
use the local-directory install for now:

```sh
claude plugin install --plugin-dir "$(git rev-parse --show-toplevel)/plugin"
```

When subpath installs are widely supported, this becomes:

```sh
claude plugin install github.com/ship-it-ops/ShipIt-AI/plugin
```

Verify the MCP server registered:

```sh
claude mcp list
# expect: shipit-ai (http) - http://localhost:3002/mcp
```

## Smoke test

In any Claude Code session, in any directory (you do not need to be inside
the ShipIt-AI repo):

1. **Start the stack** in the ShipIt-AI repo: `pnpm start:all`.
2. **Confirm the server is up:**
   ```sh
   curl -s http://localhost:3002/health
   # {"status":"ok","transport":"http"}
   ```
3. **Ask Claude:** _"What tools does the shipit-ai MCP server give me?"_ —
   the `shipit-graph` skill explains each.
4. **Real query:** _"What's the blast radius if
   `shipit://logical-service/default/payments-api` goes down?"_ — Claude
   should call `blast_radius` and return downstream services.

## Troubleshooting

| Symptom                                                                     | Likely cause                                                   | Fix                                                                                  |
| --------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `claude mcp list` shows `shipit-ai` but tool calls fail with `ECONNREFUSED` | MCP server isn't running                                       | `pnpm start:all` in the ShipIt-AI repo, or check `http://localhost:3002/health`      |
| `404 Not found` from the MCP endpoint                                       | URL is missing the `/mcp` path or you're hitting `/health`     | The full URL is `http://localhost:3002/mcp`                                          |
| Tools register but every call returns `NODE_NOT_FOUND`                      | Graph is empty — connectors haven't synced                     | Configure a connector via the ShipIt-AI web UI at `http://localhost:3000/connectors` |
| `SHIPIT_MCP_URL` not picked up                                              | Env var must be exported in the shell that started Claude Code | `export SHIPIT_MCP_URL=...` then restart the Claude Code session                     |

## What this plugin does not do (yet)

- **No auth.** The MCP HTTP endpoint is open today — fine for local dev,
  not fine for remote deployments. Token enforcement is the remaining piece
  of MCP Access Stage 2 (`docs/agent/plans/mcp-access-stage-2-real-login.md`).
  When it lands, the plugin will support a bearer token via
  `SHIPIT_MCP_TOKEN`.
- **No slash commands.** The skills give the agent a strong decision tree;
  `/shipit:owners` etc. are a v2 nice-to-have.
- **No subagents or hooks.** Future iterations may add a `graph-guide`
  subagent.

## Layout

```
plugin/
├── .claude-plugin/
│   └── plugin.json          # manifest (name, description, version, author)
├── .mcp.json                # HTTP MCP server registration
├── skills/
│   ├── shipit-graph/
│   │   └── SKILL.md         # primary — picks the right tool for the question
│   ├── shipit-cypher/
│   │   └── SKILL.md         # only loads when writing Cypher for graph_query
│   └── shipit-debugging/
│       └── SKILL.md         # only loads on MCP error codes / empty results
└── README.md
```
