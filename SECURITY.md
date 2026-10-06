# Security

ShipIt-AI is developed in the open. If you find a vulnerability, please report it privately so
it can be fixed before it is public.

## Reporting a vulnerability

- Use GitHub's private vulnerability reporting on this repository ("Report a vulnerability"
  under the Security tab), or email the maintainers at the address on the organisation's
  GitHub profile.
- Include the version or commit, the surface involved (web UI, API, MCP server, a connector),
  steps to reproduce, and the impact you believe it has.
- Please do not open a public issue or pull request that describes an unfixed weakness.

You should hear back within a few days. Fixes land on `main` through the normal pull request
flow, described by their class and their fix rather than by a working exploit.

## What is in scope

- The api-server (`packages/api-server`), the web UI, the MCP server, the agent runner and the
  knowledge worker.
- The connectors and the credentials they hold.
- The Claude Code plugin under `plugin/`.

Third-party services the product talks to (GitHub, Neo4j, Google Cloud, Kubernetes clusters)
are out of scope here; report those to their owners.

## How the codebase handles secrets

- Committed configuration never holds credentials; `shipit.config.local.yaml` is git-ignored
  and `secretlint` runs on every commit and in CI (ADR-017).
- In deployments, credentials live in Google Secret Manager and are hydrated at boot
  (ADR-025). This repository's CI holds no cloud or registry credentials (ADR-023).
- Access tokens for the MCP server are stored as salted hashes; the plaintext is shown once
  (ADR-028).

See `docs/adrs/` for the decisions behind authentication (ADR-027), first-boot setup mode
(ADR-026), the webhook receiver (ADR-030) and raw Cypher (ADR-036).
