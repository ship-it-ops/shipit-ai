# ShipIt-AI Claude Code Plugin

Connects [Claude Code](https://docs.claude.com/en/docs/claude-code) to the
ShipIt-AI knowledge graph over **HTTP**. Installing this plugin:

1. Registers the ShipIt-AI MCP server as an HTTP endpoint so the 8 read-only
   graph tools become available in any Claude Code session.
2. Loads three skills (`shipit-graph`, `shipit-cypher`, `shipit-debugging`)
   that teach the agent how to use the tools well — picking the right one
   for a question, writing safe Cypher, and recovering from errors.

The plugin lives in the same repo as the server so its version is always
locked to the server it configures ([ADR-022](../docs/adrs/ADR-022-claude-code-plugin-and-tool-metadata.md)).

## How it talks to the server

The plugin's `.mcp.json` registers a Streamable-HTTP MCP server:

```json
{
  "type": "http",
  "url": "${SHIPIT_MCP_URL:-http://localhost:3002/mcp}",
  "headers": { "Authorization": "Bearer ${SHIPIT_MCP_TOKEN:-}" }
}
```

Two environment variables, exported in the shell that starts Claude Code:

| Variable           | Default                     | Purpose                                                                |
| ------------------ | --------------------------- | ---------------------------------------------------------------------- |
| `SHIPIT_MCP_URL`   | `http://localhost:3002/mcp` | The instance's `/mcp` endpoint. Deployed: `https://<your-domain>/mcp`. |
| `SHIPIT_MCP_TOKEN` | _(empty)_                   | A personal access token from **Settings → API Keys** on that instance. |

The MCP server's HTTP transport requires a token on every request
([docs/mcp-tools.md](../docs/mcp-tools.md#streamable-http-default)); without
one every call answers `401 MISSING_TOKEN`. The token needs the `mcp:invoke`
scope. `graph_query` (raw Cypher) also needs `graph:query` — the other seven
tools work without it. A token can only carry scopes its minter holds, and
the `member` role carries neither today, so ask an administrator for one.

```sh
export SHIPIT_MCP_URL="https://shipit.your-company.com/mcp"
export SHIPIT_MCP_TOKEN="shipit_pat_..."   # shown once when minted
```

Tokens exist only on an instance where sign-in is enabled
(`accessControl.auth.enabled: true`). The local dev stack runs with sign-in
off, so against a local stack either turn sign-in on locally
([docs/local-development.md](../docs/local-development.md)) and mint a token,
or skip the plugin and register the server over stdio in your project's
`.mcp.json` — the snippet is in
[docs/mcp-tools.md](../docs/mcp-tools.md#stdio).

## Requirements

- A reachable ShipIt-AI instance (deployed, or the local dev stack on port 3002).
- A personal access token for it, as above.
- Node 22+ only if you run the dev stack yourself; Claude Code reaches the
  plugin's server over HTTP.

## Install

The plugin lives in the `plugin/` subdirectory of the ShipIt-AI repo. Today,
Claude Code's marketplace install path expects plugins at the repo root, so
use the local-directory install:

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
# expect: shipit-ai (http) - http://localhost:3002/mcp   (or your SHIPIT_MCP_URL)
```

## Smoke test

In any Claude Code session, in any directory (you do not need to be inside
the ShipIt-AI repo):

1. **Export** `SHIPIT_MCP_URL` and `SHIPIT_MCP_TOKEN`, then start Claude Code.
2. **Confirm the server is up:**
   ```sh
   curl -s "${SHIPIT_MCP_URL%/mcp}/health"
   # {"status":"ok","transport":"http"}
   ```
3. **Ask Claude:** _"What tools does the shipit-ai MCP server give me?"_ —
   the `shipit-graph` skill explains each.
4. **Real query:** _"What's the blast radius if
   `shipit://logical-service/default/payments-api` goes down?"_ — Claude
   should call `blast_radius` and return downstream services.

## Troubleshooting

| Symptom                                                                     | Likely cause                                                    | Fix                                                                                |
| --------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `claude mcp list` shows `shipit-ai` but tool calls fail with `ECONNREFUSED` | MCP server isn't running                                        | `pnpm start:all` in the ShipIt-AI repo, or check `<url without /mcp>/health`       |
| `401 MISSING_TOKEN` / `401 INVALID_TOKEN`                                   | `SHIPIT_MCP_TOKEN` is unset, mistyped, or the token was revoked | Mint a token under Settings → API Keys, export it, restart the Claude Code session |
| `403 INSUFFICIENT_SCOPE`                                                    | The token lacks `mcp:invoke`                                    | Mint a new token with that scope                                                   |
| `graph_query` answers `RBAC_DENIED`, other tools work                       | The token lacks `graph:query`                                   | Ask an administrator for a token with that scope, or use the structured tools      |
| `404 Not found` from the MCP endpoint                                       | URL is missing the `/mcp` path or you're hitting `/health`      | The full URL ends in `/mcp`                                                        |
| Tools register but every call returns `NODE_NOT_FOUND`                      | Graph is empty — connectors haven't synced                      | Configure a connector in the ShipIt-AI web UI under **Connectors**                 |
| `SHIPIT_MCP_URL` / `SHIPIT_MCP_TOKEN` not picked up                         | Env vars must be exported in the shell that started Claude Code | `export …` then restart the Claude Code session                                    |

## What this plugin does not do (yet)

- **No slash commands.** The skills give the agent a strong decision tree;
  `/shipit:owners` etc. are a v2 nice-to-have.
- **No subagents or hooks.** Future iterations may add a `graph-guide`
  subagent.
- **No stdio registration.** The plugin is HTTP-only; the stdio path is a
  plain `.mcp.json` entry ([docs/mcp-tools.md](../docs/mcp-tools.md#stdio)).

## Layout

```
plugin/
├── .claude-plugin/
│   └── plugin.json          # manifest (name, description, version, author)
├── .mcp.json                # HTTP MCP server registration (URL + bearer header)
├── skills/
│   ├── shipit-graph/
│   │   └── SKILL.md         # primary — picks the right tool for the question
│   ├── shipit-cypher/
│   │   └── SKILL.md         # only loads when writing Cypher for graph_query
│   └── shipit-debugging/
│       └── SKILL.md         # only loads on MCP error codes / empty results
└── README.md
```
