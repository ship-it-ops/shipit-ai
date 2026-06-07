# Agent Context

Last updated: 2026-06-04 | Total notes: 33

<!--
  This file is the index for `docs/agent/`. Agents read it at session start.
  Format: - [slug] | type | status | importance | YYYY-MM-DD | 8-word summary
-->

## Status (in-flight)

<!-- always-read at session start -->

_(no in-flight work)_

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
- [dependabot-resolution-strategy](decisions/dependabot-resolution-strategy.md) | decision | active | core | 2026-05-24 | pnpm.overrides + direct bumps; Fastify defer-portion superseded
- [fastify-v5-migration](decisions/fastify-v5-migration.md) | decision | active | core | 2026-05-26 | bump fastify@^5.8.5 + 3 @fastify/\* plugins; closes 6 alerts
- [connector-run-storage-redis-not-yaml](decisions/connector-run-storage-redis-not-yaml.md) | decision | active | core | 2026-05-24 | run history lives in Redis LIST per connector, not in shipit.config.local.yaml
- [github-installation-picker](decisions/github-installation-picker.md) | decision | active | core | 2026-05-24 | wizard Connect step picks org from listInstallations not paste-an-ID
- [per-org-github-app-is-default-not-shared](decisions/per-org-github-app-is-default-not-shared.md) | decision | active | core | 2026-05-24 | wizard defaults to per-org App; shared needs public App on GitHub
- [canonical-id-org-namespacing](decisions/canonical-id-org-namespacing.md) | decision | active | core | 2026-05-30 | Repository/Team/Pipeline IDs gain org segment; Person stays global
- [hosting-gke-distributed-not-vercel](decisions/hosting-gke-distributed-not-vercel.md) | decision | active | core | 2026-06-04 | deploy existing distributed stack as-is on GKE, not Vercel

## Patterns

- [connector-runner-injection](patterns/connector-runner-injection.md) | pattern | active | standard | 2026-05-20 | registry holds ConnectorRunner; scheduler is production swap
- [live-reference-for-hot-reload](patterns/live-reference-for-hot-reload.md) | pattern | active | standard | 2026-05-20 | shared object refs propagate updates without restart
- [internal-node-label-underscore-prefix](patterns/internal-node-label-underscore-prefix.md) | pattern | active | core | 2026-05-22 | exclude `_`-prefixed labels from user-facing graph queries
- [ownership-edge-semantics](patterns/ownership-edge-semantics.md) | pattern | active | core | 2026-05-30 | mark ownership-class rel types with semantics: ownership
- [reset-script-must-drain-redis-surfaces](patterns/reset-script-must-drain-redis-surfaces.md) | pattern | active | core | 2026-05-31 | seed:reset wipes Neo4j + Redis run history + BullMQ queues

## Plans

- [mcp-access-stage-2-real-login](plans/mcp-access-stage-2-real-login.md) | plan | active | standard | 2026-05-20 | remote transport tokens UI for MCP login
- [saas-tier-shared-github-app](plans/saas-tier-shared-github-app.md) | plan | active | standard | 2026-05-21 | hosted SaaS tier with ship-it-ops-owned App
- [k8s-deployment-architecture](plans/k8s-deployment-architecture.md) | plan | active | core | 2026-06-04 | deploy distributed stack as-is on GKE; learn K8s
- [deployment-runtime-modes](plans/deployment-runtime-modes.md) | plan | superseded | core | 2026-06-04 | SUPERSEDED Vercel/serverless/embedded exploration; see k8s plan

## Open Questions

- [per-app-webhook-secrets](open-questions/per-app-webhook-secrets.md) | open-question | active | standard | 2026-05-20 | per-org App webhook secret lookup needed for P1
- [tenant-to-source-org-mapping](open-questions/tenant-to-source-org-mapping.md) | open-question | active | standard | 2026-06-01 | ctx.org maps to which `_source_org` values? Blocks B6 org filter
- [replay-stream-wire-or-cut](open-questions/replay-stream-wire-or-cut.md) | open-question | active | standard | 2026-06-04 | replay() unused; cut Redis Stream or wire it up
- [manual-edit-write-path](open-questions/manual-edit-write-path.md) | open-question | active | standard | 2026-06-04 | manual claim/edge write endpoints unbuilt; source-priority inconsistency
- [cookie-domain-topology](open-questions/cookie-domain-topology.md) | open-question | answered | standard | 2026-06-04 | RESOLVED by single-origin Ingress on GKE; Vercel split dropped

## Scars

- [web-ui-cannot-import-mcp-server-root](scars/web-ui-cannot-import-mcp-server-root.md) | scar | active | core | 2026-05-31 | workspace root barrels drag node:fs into web-ui bundle
- [github-app-manifest-is-post-not-get](scars/github-app-manifest-is-post-not-get.md) | scar | active | core | 2026-05-22 | GitHub App manifest requires POST form not manifest_url GET
- [claude-code-mcp-cwd-field-ignored](scars/claude-code-mcp-cwd-field-ignored.md) | scar | active | core | 2026-05-21 | Claude Code silently ignores cwd in .mcp.json files
- [bullmq-5-forbids-colons-in-queue-names-and-job-ids](scars/bullmq-5-forbids-colons-in-queue-names-and-job-ids.md) | scar | active | core | 2026-05-22 | BullMQ 5 throws on `:` in queue names + job IDs
- [connectorinfo-status-degraded-is-overloaded-as-syncing](scars/connectorinfo-status-degraded-is-overloaded-as-syncing.md) | scar | active | core | 2026-05-30 | `info.status='degraded'` doubles as syncing; never render raw
