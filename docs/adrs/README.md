# Architecture Decision Records

ADRs capture significant architectural decisions, the context that drove them, and the trade-offs we accepted. Each one is self-contained — read in isolation when you hit a question about "why is this designed this way?"

New ADRs use [`_ADR_TEMPLATE.md`](_ADR_TEMPLATE.md) and are numbered in commit order. Status values: `Proposed`, `Accepted`, `Deprecated`, `Superseded by ADR-XXX`.

## Index

| ADR                                                              | Title                                              |
| ---------------------------------------------------------------- | -------------------------------------------------- |
| [ADR-001](ADR-001-api-server-language.md)                        | All-TypeScript Stack                               |
| [ADR-002](ADR-002-propertyclaim-storage.md)                      | PropertyClaim Storage as JSON on Nodes             |
| [ADR-003](ADR-003-phase1-mvp-scope.md)                           | Phase 1 MVP Scope                                  |
| [ADR-004](ADR-004-event-bus-strategy.md)                         | Tiered Event Bus (BullMQ → Kafka)                  |
| [ADR-005](ADR-005-defer-vector-db.md)                            | Defer Vector DB to Phase 2                         |
| [ADR-006](ADR-006-schema-configuration.md)                       | YAML Schema Configuration                          |
| [ADR-007](ADR-007-neo4j-ha-strategy.md)                          | Neo4j High Availability Strategy                   |
| [ADR-008](ADR-008-mcp-response-envelope.md)                      | MCP Response Envelope Standard                     |
| [ADR-009](ADR-009-schema-storage.md)                             | Schema Storage in Neo4j                            |
| [ADR-010](ADR-010-identity-resolution-phasing.md)                | Identity Resolution Phasing                        |
| [ADR-011](ADR-011-service-model-simple-mode.md)                  | Service Model Simple Mode                          |
| [ADR-012](ADR-012-accessibility-standards.md)                    | Accessibility Standards                            |
| [ADR-013](ADR-013-web-design-system.md)                          | Adopt `@ship-it-ui/*` as the Web Design System     |
| [ADR-014](ADR-014-layered-local-configuration.md)                | Layered Local Configuration                        |
| [ADR-015](ADR-015-first-run-dev-onboarding.md)                   | First-Run Dev Onboarding in the Web UI             |
| [ADR-016](ADR-016-optimistic-concurrency-for-editable-config.md) | Optimistic Concurrency for Editable On-Disk Config |
| [ADR-017](ADR-017-secret-scanning-with-secretlint.md)            | Secret Scanning via Secretlint                     |
