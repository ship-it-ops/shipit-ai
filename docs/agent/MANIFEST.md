# Agent Context

Last updated: 2026-06-23 | Total notes: 75

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
- [apiserver-crashloop-unhandled-bullmq-error-on-oom-redis](investigations/apiserver-crashloop-unhandled-bullmq-error-on-oom-redis.md) | investigation | fixed | core | 2026-06-22 | no '.on(error)' on BullMQ Worker/Queue/ioredis → OOM moveToActive crashes process at boot; attach error listeners + resilient startRunner

<!--
  This file is the index for `docs/agent/`. Agents read it at session start.
  Format: - [slug] | type | status | importance | YYYY-MM-DD | 8-word summary
-->

## Status (in-flight)

<!-- always-read at session start -->

_None in flight. All prior status entries shipped to main and were archived 2026-06-23 (reconciled: their original commit hashes were squashed away on PR merge, but every feature is present on main — #76/#85/#86/#87 + DS bumps)._

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
- [per-node-source-connector-id](decisions/per-node-source-connector-id.md) | decision | active | standard | 2026-05-28 | stamp \_source_connector_id from envelope; powers catalog source facet/pills

## Patterns

- [connector-runner-injection](patterns/connector-runner-injection.md) | pattern | active | standard | 2026-05-20 | registry holds ConnectorRunner; scheduler is production swap
- [live-reference-for-hot-reload](patterns/live-reference-for-hot-reload.md) | pattern | active | standard | 2026-05-20 | shared object refs propagate updates without restart
- [internal-node-label-underscore-prefix](patterns/internal-node-label-underscore-prefix.md) | pattern | active | core | 2026-05-22 | exclude `_`-prefixed labels from user-facing graph queries
- [ownership-edge-semantics](patterns/ownership-edge-semantics.md) | pattern | active | core | 2026-05-30 | mark ownership-class rel types with semantics: ownership
- [reset-script-must-drain-redis-surfaces](patterns/reset-script-must-drain-redis-surfaces.md) | pattern | active | core | 2026-05-31 | seed:reset wipes Neo4j + Redis run history + BullMQ queues

## Plans

- [integration-tests-wave-cd-handoff](plans/integration-tests-wave-cd-handoff.md) | plan | completed | core | 2026-06-20 | COMPLETE: #5/#3/#9/#8 + both unit follow-ups done; harness recipe + per-item record retained
- [integration-test-coverage-roadmap](plans/integration-test-coverage-roadmap.md) | plan | completed | core | 2026-06-20 | COMPLETE: all 10 prioritized integration-test gaps (Waves A+B+C+D) + 2 unit follow-ups; scar mapping retained
- [webhook-cut-b-content-freshness](plans/webhook-cut-b-content-freshness.md) | plan | completed | core | 2026-06-19 | spec-6 Cut B: content-version + ATOMIC in-Cypher guard; IMPLEMENTED (Option B + cleanup), tests green, uncommitted
- [ds-upstream-theming-prompt](plans/ds-upstream-theming-prompt.md) | plan | completed | standard | 2026-06-19 | DONE — DS shipped on-accent token + screen→gutter rename (tokens 0.0.9 / ui 0.0.20)
- [admin-portal-settings](plans/admin-portal-settings.md) | plan | completed | core | 2026-06-23 | SHIPPED (#76): admin settings hub — webhook setup/rotate, OAuth, admins, allow-list
- [github-webhook-receiver](plans/github-webhook-receiver.md) | plan | completed | core | 2026-06-23 | SHIPPED: HMAC verify, per-App secret, coalesced refetch; Cut A (#76) + Cut B both landed
- [mcp-access-stage-2-real-login](plans/mcp-access-stage-2-real-login.md) | plan | completed | standard | 2026-06-23 | SHIPPED (#48/#67): bearer enforcement + token CRUD + API Keys UI; only mcp-server infra exposure remains
- [login-user-as-person-entity](plans/login-user-as-person-entity.md) | plan | completed | core | 2026-06-23 | SHIPPED (#67, hardened #73): login upserts a Person via event-bus; shared canonical-id merges with connector
- [saas-tier-shared-github-app](plans/saas-tier-shared-github-app.md) | plan | active | standard | 2026-05-21 | hosted SaaS tier with ship-it-ops-owned App
- [k8s-deployment-architecture](plans/k8s-deployment-architecture.md) | plan | active | core | 2026-06-04 | deploy distributed stack as-is on GKE; learn K8s
- [gsm-secret-store-implementation](plans/gsm-secret-store-implementation.md) | plan | completed | core | 2026-06-10 | 12-task TDD plan for GSM secrets + config export
- [deployment-runtime-modes](plans/deployment-runtime-modes.md) | plan | superseded | core | 2026-06-04 | SUPERSEDED Vercel/serverless/embedded exploration; see k8s plan

## Open Questions

- [per-app-webhook-secrets](open-questions/per-app-webhook-secrets.md) | open-question | answered | standard | 2026-06-18 | ANSWERED — receiver built (Cut A); per-App sidecar secret, no global downgrade
- [cutb-option-b-rewrite-wave](open-questions/cutb-option-b-rewrite-wave.md) | open-question | answered | standard | 2026-06-19 | ANSWERED — Option B + schedule cleanup; one-time re-write wave accepted at current scale
- [codeowner-edge-out-of-order-ordering](open-questions/codeowner-edge-out-of-order-ordering.md) | open-question | active | standard | 2026-06-19 | edges (CODEOWNER_OF etc.) have no ordering guard; mergeEdge is last-writer-wins — protect or accept?
- [tenant-to-source-org-mapping](open-questions/tenant-to-source-org-mapping.md) | open-question | active | standard | 2026-06-01 | ctx.org maps to which `_source_org` values? Blocks B6 org filter
- [replay-stream-wire-or-cut](open-questions/replay-stream-wire-or-cut.md) | open-question | answered | standard | 2026-06-22 | RESOLVED — CUT: shipit-event-log gated off by default (+MAXLEN if on); was the ~825MB OOM key
- [manual-edit-write-path](open-questions/manual-edit-write-path.md) | open-question | active | standard | 2026-06-23 | Gap2 source-priority FIXED (#74 shared registry); Gap1 partial — manual-override route, add-relation route, claim-write RBAC still open
- [cookie-domain-topology](open-questions/cookie-domain-topology.md) | open-question | answered | standard | 2026-06-04 | RESOLVED by single-origin Ingress on GKE; Vercel split dropped
- [allow-list-secret-not-app-writable](open-questions/allow-list-secret-not-app-writable.md) | open-question | answered | standard | 2026-06-18 | RESOLVED — infra grant made; allow-list write shipped in Portal Settings
- [redis-dataset-unbounded-growth](open-questions/redis-dataset-unbounded-growth.md) | open-question | answered | standard | 2026-06-22 | CORRECTED — dominant key is shipit-event-log stream (~825MB), not BullMQ; #75 freed ~nothing; cut the stream

- [neo4j-no-indexes-declared](open-questions/neo4j-no-indexes-declared.md) | open-question | active | standard | 2026-06-23 | PARKED as future backlog — not starting indexes yet; revisit when graph outgrows demo scale (PR #87 IN7)

## Scars

- [integration-tests-sharing-a-db-must-run-serially](scars/integration-tests-sharing-a-db-must-run-serially.md) | scar | active | core | 2026-06-19 | integration tests green alone but red together = vitest parallel files clobbering a shared real DB; --no-file-parallelism or isolate
- [pnpm-install-under-live-next-dev-serves-stale-bundle](scars/pnpm-install-under-live-next-dev-serves-stale-bundle.md) | scar | active | core | 2026-06-19 | empty/blank local web-ui right after pnpm install = stale next dev serving old node_modules; restart before suspecting data loss
- [tailwind-spacing-screen-key-shadows-h-screen](scars/tailwind-spacing-screen-key-shadows-h-screen.md) | scar | active | core | 2026-06-18 | a `--spacing-screen` @theme key shadows Tailwind's reserved h-screen → 100vh becomes 16px, shell collapses
- [dedup-token-before-failable-side-effect-swallows-retry](scars/dedup-token-before-failable-side-effect-swallows-retry.md) | scar | active | core | 2026-06-18 | set a dedup token before a failable+retried step → release it on failure or the retry is lost
- [redis-memory-limit-below-dataset-oomkills](scars/redis-memory-limit-below-dataset-oomkills.md) | scar | active | core | 2026-06-17 | empty UI + healthy app = check redis-0 OOMKilled before suspecting data loss
- [web-ui-cannot-import-mcp-server-root](scars/web-ui-cannot-import-mcp-server-root.md) | scar | active | core | 2026-05-31 | workspace root barrels drag node:fs into web-ui bundle
- [github-app-manifest-is-post-not-get](scars/github-app-manifest-is-post-not-get.md) | scar | active | core | 2026-05-22 | GitHub App manifest requires POST form not manifest_url GET
- [claude-code-mcp-cwd-field-ignored](scars/claude-code-mcp-cwd-field-ignored.md) | scar | active | core | 2026-05-21 | Claude Code silently ignores cwd in .mcp.json files
- [bullmq-5-forbids-colons-in-queue-names-and-job-ids](scars/bullmq-5-forbids-colons-in-queue-names-and-job-ids.md) | scar | active | core | 2026-05-22 | BullMQ 5 throws on `:` in queue names + job IDs
- [connectorinfo-status-degraded-is-overloaded-as-syncing](scars/connectorinfo-status-degraded-is-overloaded-as-syncing.md) | scar | active | core | 2026-05-30 | `info.status='degraded'` doubles as syncing; never render raw
- [pnpm-implicit-types-node-hoisting-breaks-on-vitest-4](scars/pnpm-implicit-types-node-hoisting-breaks-on-vitest-4.md) | scar | active | core | 2026-06-07 | vitest 3→4 surfaces undeclared @types/node deps in five workspaces
- [docker-copy-of-host-artifacts-poisons-image-builds](scars/docker-copy-of-host-artifacts-poisons-image-builds.md) | scar | active | core | 2026-06-11 | host node_modules/tsbuildinfo in COPY break image builds
