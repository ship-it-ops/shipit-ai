# Agent Context

Last updated: 2026-05-24 | Total notes: 21

<!--
  This file is the index for `docs/agent/`. Agents read it at session start.
  Format: - [slug] | type | status | importance | YYYY-MM-DD | 8-word summary
-->

## Status (in-flight)

<!-- always-read at session start -->

- [handoff-github-connector-wizard-mid-flow](status/handoff-github-connector-wizard-mid-flow.md) | status | active | core | 2026-05-22 | mid-flow: user verifying scheduler-attach fix end-to-end
- [dependabot-resolution-pending-push-and-dismissals](status/dependabot-resolution-pending-push-and-dismissals.md) | status | active | standard | 2026-05-24 | upgrades land locally; commit + Fastify alert dismissals pending

## Decisions

- [agent-context-initialized](decisions/agent-context-initialized.md) | decision | active | core | 2026-05-20 | docs/agent scaffolded during MCP Access stage one
- [mcp-tool-metadata-as-pure-data-module](decisions/mcp-tool-metadata-as-pure-data-module.md) | decision | active | core | 2026-05-20 | tool descriptions live in metadata.ts not register
- [github-connector-architecture-v1](decisions/github-connector-architecture-v1.md) | decision | active | core | 2026-05-20 | App-only auth, one connector per org, polling+webhooks
- [top-level-connectors-config-section](decisions/top-level-connectors-config-section.md) | decision | active | core | 2026-05-20 | connectors live at root not under backend
- [per-org-github-app-override](decisions/per-org-github-app-override.md) | decision | active | core | 2026-05-20 | per-instance App overrides global App field-by-field
- [etag-optimistic-concurrency-for-editable-config](decisions/etag-optimistic-concurrency-for-editable-config.md) | decision | active | core | 2026-05-20 | ETag pattern shared across schema, registry, app services
- [github-app-manifest-flow](decisions/github-app-manifest-flow.md) | decision | active | core | 2026-05-21 | wizard creates App via GitHub manifest endpoint not manually
- [claude-code-plugin-in-monorepo-with-skills](decisions/claude-code-plugin-in-monorepo-with-skills.md) | decision | active | core | 2026-05-21 | plugin lives in plugin/, ships three skills, not separate repo
- [core-writer-runs-as-its-own-process](decisions/core-writer-runs-as-its-own-process.md) | decision | active | core | 2026-05-22 | core-writer is a separate worker process, owns Neo4j adapters
- [dependabot-resolution-strategy](decisions/dependabot-resolution-strategy.md) | decision | active | core | 2026-05-24 | pnpm.overrides + direct bumps; dismiss Fastify v5-only alerts
- [connector-run-storage-redis-not-yaml](decisions/connector-run-storage-redis-not-yaml.md) | decision | active | core | 2026-05-24 | run history lives in Redis LIST per connector, not in shipit.config.local.yaml

## Patterns

- [connector-runner-injection](patterns/connector-runner-injection.md) | pattern | active | standard | 2026-05-20 | registry holds ConnectorRunner; scheduler is production swap
- [live-reference-for-hot-reload](patterns/live-reference-for-hot-reload.md) | pattern | active | standard | 2026-05-20 | shared object refs propagate updates without restart
- [internal-node-label-underscore-prefix](patterns/internal-node-label-underscore-prefix.md) | pattern | active | core | 2026-05-22 | exclude `_`-prefixed labels from user-facing graph queries

## Plans

- [mcp-access-stage-2-real-login](plans/mcp-access-stage-2-real-login.md) | plan | active | standard | 2026-05-20 | remote transport tokens UI for MCP login
- [saas-tier-shared-github-app](plans/saas-tier-shared-github-app.md) | plan | active | standard | 2026-05-21 | hosted SaaS tier with ship-it-ops-owned App

## Open Questions

- [canonical-id-org-namespacing](open-questions/canonical-id-org-namespacing.md) | open-question | active | core | 2026-05-20 | Repository IDs collide across orgs decide before ship
- [per-app-webhook-secrets](open-questions/per-app-webhook-secrets.md) | open-question | active | standard | 2026-05-20 | per-org App webhook secret lookup needed for P1

## Scars

- [web-ui-cannot-import-mcp-server-root](scars/web-ui-cannot-import-mcp-server-root.md) | scar | active | core | 2026-05-20 | mcp-server root export drags shared into bundle
- [github-app-manifest-is-post-not-get](scars/github-app-manifest-is-post-not-get.md) | scar | active | core | 2026-05-22 | GitHub App manifest requires POST form not manifest_url GET
- [claude-code-mcp-cwd-field-ignored](scars/claude-code-mcp-cwd-field-ignored.md) | scar | active | core | 2026-05-21 | Claude Code silently ignores cwd in .mcp.json files
- [bullmq-5-forbids-colons-in-queue-names-and-job-ids](scars/bullmq-5-forbids-colons-in-queue-names-and-job-ids.md) | scar | active | core | 2026-05-22 | BullMQ 5 throws on `:` in queue names + job IDs
