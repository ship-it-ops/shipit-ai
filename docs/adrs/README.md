# Architecture Decision Records

ADRs capture significant architectural decisions, the context that drove them, and the trade-offs we accepted. Each one is self-contained — read in isolation when you hit a question about "why is this designed this way?"

New ADRs use [`_ADR_TEMPLATE.md`](_ADR_TEMPLATE.md) and are numbered in commit order. Status values: `Proposed`, `Accepted`, `Deprecated`, `Superseded by ADR-XXX`.

## Index

| ADR                                                                 | Title                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| [ADR-001](ADR-001-api-server-language.md)                           | All-TypeScript Stack                                                     |
| [ADR-002](ADR-002-propertyclaim-storage.md)                         | PropertyClaim Storage as JSON on Nodes                                   |
| [ADR-003](ADR-003-phase1-mvp-scope.md)                              | Phase 1 MVP Scope                                                        |
| [ADR-004](ADR-004-event-bus-strategy.md)                            | Tiered Event Bus (BullMQ → Kafka)                                        |
| [ADR-005](ADR-005-defer-vector-db.md)                               | Defer Vector DB to Phase 2 (superseded by ADR-035)                       |
| [ADR-006](ADR-006-schema-configuration.md)                          | YAML Schema Configuration                                                |
| [ADR-007](ADR-007-neo4j-ha-strategy.md)                             | Neo4j High Availability Strategy                                         |
| [ADR-008](ADR-008-mcp-response-envelope.md)                         | MCP Response Envelope Standard                                           |
| [ADR-009](ADR-009-schema-storage.md)                                | Schema Storage in Neo4j                                                  |
| [ADR-010](ADR-010-identity-resolution-phasing.md)                   | Identity Resolution Phasing                                              |
| [ADR-011](ADR-011-service-model-simple-mode.md)                     | Service Model Simple Mode                                                |
| [ADR-012](ADR-012-accessibility-standards.md)                       | Accessibility Standards                                                  |
| [ADR-013](ADR-013-web-design-system.md)                             | Adopt `@ship-it-ui/*` as the Web Design System                           |
| [ADR-014](ADR-014-layered-local-configuration.md)                   | Layered Local Configuration                                              |
| [ADR-015](ADR-015-first-run-dev-onboarding.md)                      | First-Run Dev Onboarding in the Web UI                                   |
| [ADR-016](ADR-016-optimistic-concurrency-for-editable-config.md)    | Optimistic Concurrency for Editable On-Disk Config                       |
| [ADR-017](ADR-017-secret-scanning-with-secretlint.md)               | Secret Scanning via Secretlint                                           |
| [ADR-018](ADR-018-github-connector-v1.md)                           | GitHub Connector v1: App-Only Auth, One Connector per Org, Per-Org Apps  |
| [ADR-019](ADR-019-core-writer-separate-process.md)                  | The Core Writer Runs as Its Own Process                                  |
| [ADR-020](ADR-020-connector-run-history-in-redis.md)                | Connector Run History Lives in Redis                                     |
| [ADR-021](ADR-021-org-scoped-canonical-ids-and-source-connector.md) | Org-Scoped Canonical IDs and Per-Node Source Connector                   |
| [ADR-022](ADR-022-claude-code-plugin-and-tool-metadata.md)          | Claude Code Plugin in the Monorepo; Tool Metadata as Pure Data           |
| [ADR-023](ADR-023-hosting-on-gke-images-built-by-infra.md)          | Host on GKE; the Infrastructure Repository Builds Images                 |
| [ADR-024](ADR-024-runtime-config-persistence.md)                    | Runtime Configuration Persistence: Ephemeral Volume First, Postgres Next |
| [ADR-025](ADR-025-secrets-in-google-secret-manager.md)              | Credentials in Google Secret Manager                                     |
| [ADR-026](ADR-026-first-boot-setup-mode.md)                         | First-Boot Setup Mode                                                    |
| [ADR-027](ADR-027-login-and-access-model.md)                        | Login and Access Model                                                   |
| [ADR-028](ADR-028-mcp-token-auth.md)                                | The MCP Server's HTTP Surface Requires Per-User Tokens                   |
| [ADR-029](ADR-029-per-field-confidence-and-verification.md)         | Per-Field Confidence and Human Verification                              |
| [ADR-030](ADR-030-github-webhook-receiver.md)                       | GitHub Webhook Receiver                                                  |
| [ADR-031](ADR-031-feedback-widget-service-identity.md)              | The Feedback Widget Files Issues with a Service Identity                 |
| [ADR-032](ADR-032-dependency-and-image-hygiene.md)                  | Dependency and Image Hygiene                                             |
| [ADR-033](ADR-033-kubernetes-connector-v1.md)                       | Kubernetes Connector v1                                                  |
| [ADR-034](ADR-034-agent-platform-v1-foundations.md)                 | Agent Platform v1 Foundations                                            |
| [ADR-035](ADR-035-knowledge-layer-v1-foundations.md)                | Knowledge Layer v1 Foundations                                           |
| [ADR-036](ADR-036-raw-cypher-read-only-check-and-executor.md)       | Caller-Written Cypher: One Check, One Executor, Administrators Only      |
