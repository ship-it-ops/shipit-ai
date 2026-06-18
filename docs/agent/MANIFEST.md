# Agent Context

Last updated: 2026-06-18 | Total notes: 59

## Investigations

- [web-ui-dockerfile-three-layered-build-failure](investigations/web-ui-dockerfile-three-layered-build-failure.md) | investigation | completed | standard | 2026-06-11 | corepack, missing workspace install, wrong standalone paths stacked
- [backend-images-runtime-module-not-found](investigations/backend-images-runtime-module-not-found.md) | investigation | completed | standard | 2026-06-11 | root node_modules copy broke resolution; pnpm deploy fixes
- [setup-wizard-manifest-launch-enoent](investigations/setup-wizard-manifest-launch-enoent.md) | investigation | completed | core | 2026-06-11 | manifest template JSON never reaches /data in cluster
- [first-login-redirect-uri-and-missing-callback-urls](investigations/first-login-redirect-uri-and-missing-callback-urls.md) | investigation | completed | core | 2026-06-12 | path-only /api doubled redirect_uri; manifest lacked callback_urls
- [login-loop-secure-cookie-trustproxy](investigations/login-loop-secure-cookie-trustproxy.md) | investigation | completed | core | 2026-06-12 | missing trustProxy silently dropped Secure session cookie
- [portal-demo-502-node-recreation-neg-drain](investigations/portal-demo-502-node-recreation-neg-drain.md) | investigation | completed | core | 2026-06-15 | single-node recreation drained NEGs to 0; LB 502'd everything; self-healed
- [per-org-manifest-created-app-invisible-confirmation](investigations/per-org-manifest-created-app-invisible-confirmation.md) | investigation | completed | core | 2026-06-15 | per-org App created+claimed OK but creds hidden in collapsed details; added ok-Banner
- [person-canonical-id-login-case-mismatch](investigations/person-canonical-id-login-case-mismatch.md) | investigation | fixed | core | 2026-06-15 | connector keyed Person id by raw login (uppercase never merged); shared buildPersonCanonicalId lowercases both sides + core-writer migration
- [team-ownership-invisible-owns-and-blast-radius](investigations/team-ownership-invisible-owns-and-blast-radius.md) | investigation | fixed | core | 2026-06-16 | team-service + web-UI blast-radius only walked OWNS; added CODEOWNER_OF (downstream-only); uncommitted
- [last-synced-frozen-by-idempotency-dedup](investigations/last-synced-frozen-by-idempotency-dedup.md) | investigation | fixed | core | 2026-06-16 | \_last_synced frozen by idempotency skip; now bump timestamp on skip; content-change suppression still open
- [redis-oom-crashloop-data-appears-gone](investigations/redis-oom-crashloop-data-appears-gone.md) | investigation | completed | core | 2026-06-17 | redis dataset 246MB > 256Mi limit OOMKilled; UI looked empty; data intact

<!--
  This file is the index for `docs/agent/`. Agents read it at session start.
  Format: - [slug] | type | status | importance | YYYY-MM-DD | 8-word summary
-->

## Status (in-flight)

<!-- always-read at session start -->

- [webhook-receiver-cut-a-impl](status/webhook-receiver-cut-a-impl.md) | status | active | core | 2026-06-18 | GitHub webhook receiver Cut A implemented + reviewed; all tests green, uncommitted

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
- [dependabot-resolution-strategy](decisions/dependabot-resolution-strategy.md) | decision | active | core | 2026-06-07 | pnpm.overrides + direct bumps; 2026-06-07 round aggregated 8 of 14 PRs
- [fastify-v5-migration](decisions/fastify-v5-migration.md) | decision | active | core | 2026-05-26 | bump fastify@^5.8.5 + 3 @fastify/\* plugins; closes 6 alerts
- [connector-run-storage-redis-not-yaml](decisions/connector-run-storage-redis-not-yaml.md) | decision | active | core | 2026-05-24 | run history lives in Redis LIST per connector, not in shipit.config.local.yaml
- [github-installation-picker](decisions/github-installation-picker.md) | decision | active | core | 2026-05-24 | wizard Connect step picks org from listInstallations not paste-an-ID
- [per-org-github-app-is-default-not-shared](decisions/per-org-github-app-is-default-not-shared.md) | decision | active | core | 2026-05-24 | wizard defaults to per-org App; shared needs public App on GitHub
- [canonical-id-org-namespacing](decisions/canonical-id-org-namespacing.md) | decision | active | core | 2026-05-30 | Repository/Team/Pipeline IDs gain org segment; Person stays global
- [hosting-gke-distributed-not-vercel](decisions/hosting-gke-distributed-not-vercel.md) | decision | active | core | 2026-06-04 | deploy existing distributed stack as-is on GKE, not Vercel
- [api-server-config-persistence-strategy](decisions/api-server-config-persistence-strategy.md) | decision | active | core | 2026-06-07 | ephemeral emptyDir for v1, Postgres config store next
- [image-build-owned-by-infra-repo](decisions/image-build-owned-by-infra-repo.md) | decision | active | core | 2026-06-07 | infra repo builds+publishes images; public app repo holds no GCP creds
- [gsm-secret-store-and-config-export](decisions/gsm-secret-store-and-config-export.md) | decision | active | core | 2026-06-09 | SecretStore + boot hydration persists wizard credentials to GSM
- [setup-mode-first-boot](decisions/setup-mode-first-boot.md) | decision | active | core | 2026-06-11 | first-boot setup mode: trigger, GSM derivation, restart flip
- [gsm-backed-login-allowlist](decisions/gsm-backed-login-allowlist.md) | decision | active | core | 2026-06-12 | allow-list via GSM secret; admins always bypass
- [auth-oauth-app-separate-from-connector](decisions/auth-oauth-app-separate-from-connector.md) | decision | active | core | 2026-06-14 | login = classic OAuth App; manifest flow connector-only
- [connector-apps-gsm-blob-durability](decisions/connector-apps-gsm-blob-durability.md) | decision | active | core | 2026-06-14 | per-org connectors durable via one GSM connector-apps blob
- [mcp-token-auth-stage-2a](decisions/mcp-token-auth-stage-2a.md) | decision | active | core | 2026-06-14 | mcp-server enforces per-user bearer tokens; shared token crypto
- [per-field-confidence-and-verification](decisions/per-field-confidence-and-verification.md) | decision | active | core | 2026-06-15 | hybrid heuristic confidence engine + derived verification status; corroboration/ambiguity/verify
- [webhook-receiver-design](decisions/webhook-receiver-design.md) | decision | active | core | 2026-06-18 | HMAC verify-first receiver; per-App secret no-downgrade; coalesced targeted refetch

## Patterns

- [connector-runner-injection](patterns/connector-runner-injection.md) | pattern | active | standard | 2026-05-20 | registry holds ConnectorRunner; scheduler is production swap
- [live-reference-for-hot-reload](patterns/live-reference-for-hot-reload.md) | pattern | active | standard | 2026-05-20 | shared object refs propagate updates without restart
- [internal-node-label-underscore-prefix](patterns/internal-node-label-underscore-prefix.md) | pattern | active | core | 2026-05-22 | exclude `_`-prefixed labels from user-facing graph queries
- [ownership-edge-semantics](patterns/ownership-edge-semantics.md) | pattern | active | core | 2026-05-30 | mark ownership-class rel types with semantics: ownership
- [reset-script-must-drain-redis-surfaces](patterns/reset-script-must-drain-redis-surfaces.md) | pattern | active | core | 2026-05-31 | seed:reset wipes Neo4j + Redis run history + BullMQ queues

## Plans

- [github-webhook-receiver](plans/github-webhook-receiver.md) | plan | active | core | 2026-06-18 | audited receiver: HMAC verify, per-App secret, coalesced refetch; Cut A/B split
- [mcp-access-stage-2-real-login](plans/mcp-access-stage-2-real-login.md) | plan | active | standard | 2026-05-20 | remote transport tokens UI for MCP login
- [login-user-as-person-entity](plans/login-user-as-person-entity.md) | plan | active | core | 2026-06-14 | upsert logged-in user as a Person via event-bus on login
- [saas-tier-shared-github-app](plans/saas-tier-shared-github-app.md) | plan | active | standard | 2026-05-21 | hosted SaaS tier with ship-it-ops-owned App
- [k8s-deployment-architecture](plans/k8s-deployment-architecture.md) | plan | active | core | 2026-06-04 | deploy distributed stack as-is on GKE; learn K8s
- [gsm-secret-store-implementation](plans/gsm-secret-store-implementation.md) | plan | completed | core | 2026-06-10 | 12-task TDD plan for GSM secrets + config export
- [deployment-runtime-modes](plans/deployment-runtime-modes.md) | plan | superseded | core | 2026-06-04 | SUPERSEDED Vercel/serverless/embedded exploration; see k8s plan

## Open Questions

- [per-app-webhook-secrets](open-questions/per-app-webhook-secrets.md) | open-question | answered | standard | 2026-06-18 | ANSWERED — receiver built (Cut A); per-App sidecar secret, no global downgrade
- [tenant-to-source-org-mapping](open-questions/tenant-to-source-org-mapping.md) | open-question | active | standard | 2026-06-01 | ctx.org maps to which `_source_org` values? Blocks B6 org filter
- [replay-stream-wire-or-cut](open-questions/replay-stream-wire-or-cut.md) | open-question | active | standard | 2026-06-04 | replay() unused; cut Redis Stream or wire it up
- [manual-edit-write-path](open-questions/manual-edit-write-path.md) | open-question | active | standard | 2026-06-04 | manual claim/edge write endpoints unbuilt; source-priority inconsistency
- [cookie-domain-topology](open-questions/cookie-domain-topology.md) | open-question | answered | standard | 2026-06-04 | RESOLVED by single-origin Ingress on GKE; Vercel split dropped
- [redis-dataset-unbounded-growth](open-questions/redis-dataset-unbounded-growth.md) | open-question | answered | standard | 2026-06-18 | RESOLVED — BullMQ retention bounds shipped #75 + deployed; bigkeys verify pending

## Scars

- [dedup-token-before-failable-side-effect-swallows-retry](scars/dedup-token-before-failable-side-effect-swallows-retry.md) | scar | active | core | 2026-06-18 | set a dedup token before a failable+retried step → release it on failure or the retry is lost
- [redis-memory-limit-below-dataset-oomkills](scars/redis-memory-limit-below-dataset-oomkills.md) | scar | active | core | 2026-06-17 | empty UI + healthy app = check redis-0 OOMKilled before suspecting data loss
- [web-ui-cannot-import-mcp-server-root](scars/web-ui-cannot-import-mcp-server-root.md) | scar | active | core | 2026-05-31 | workspace root barrels drag node:fs into web-ui bundle
- [github-app-manifest-is-post-not-get](scars/github-app-manifest-is-post-not-get.md) | scar | active | core | 2026-05-22 | GitHub App manifest requires POST form not manifest_url GET
- [claude-code-mcp-cwd-field-ignored](scars/claude-code-mcp-cwd-field-ignored.md) | scar | active | core | 2026-05-21 | Claude Code silently ignores cwd in .mcp.json files
- [bullmq-5-forbids-colons-in-queue-names-and-job-ids](scars/bullmq-5-forbids-colons-in-queue-names-and-job-ids.md) | scar | active | core | 2026-05-22 | BullMQ 5 throws on `:` in queue names + job IDs
- [connectorinfo-status-degraded-is-overloaded-as-syncing](scars/connectorinfo-status-degraded-is-overloaded-as-syncing.md) | scar | active | core | 2026-05-30 | `info.status='degraded'` doubles as syncing; never render raw
- [pnpm-implicit-types-node-hoisting-breaks-on-vitest-4](scars/pnpm-implicit-types-node-hoisting-breaks-on-vitest-4.md) | scar | active | core | 2026-06-07 | vitest 3→4 surfaces undeclared @types/node deps in five workspaces
- [docker-copy-of-host-artifacts-poisons-image-builds](scars/docker-copy-of-host-artifacts-poisons-image-builds.md) | scar | active | core | 2026-06-11 | host node_modules/tsbuildinfo in COPY break image builds
