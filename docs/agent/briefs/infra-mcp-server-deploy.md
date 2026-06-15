# Infra brief — deploy + expose the mcp-server (remote MCP, token-gated)

**For:** `Ship-It-Ops/shipit-ai-infra` (GKE manifests / Helm).
**From:** app repo, 2026-06-14. **Enables:** remote MCP access with per-user tokens
(`docs/agent/decisions/mcp-token-auth-stage-2a.md`). The mcp-server now enforces
`Authorization: Bearer <token>` on its HTTP surface; it just isn't deployed yet.

## What the app provides

- `packages/mcp-server` runs an HTTP transport when `MCP_TRANSPORT=http` (default), serving
  MCP at `/mcp` and a `/health` check on `MCP_HTTP_PORT` (default `3002`). Dockerfile already
  `EXPOSE`s 3002.
- It connects **directly to Neo4j** (read-only) using `NEO4J_URI` / `NEO4J_USER` /
  `NEO4J_PASSWORD` — the same Aura creds the other services use.
- Auth is handled in-app (per-user tokens validated against Neo4j `_AccessToken`); the
  ingress does NOT need to do auth. `/health` is unauthenticated for readiness probes.

## Required changes

1. **Deployment + Service (ClusterIP)** for `mcp-server` (mirror the api-server pattern):
   env `MCP_TRANSPORT=http`, `MCP_HTTP_PORT=3002`, Neo4j creds from the existing secret/ESO,
   readiness/liveness on `GET /health` (200 `{status:"ok"}`). `replicas: 1` is fine
   (stateless; can scale later — no in-memory session state).
2. **Ingress route** — recommend the existing single-origin host with
   **path `/mcp` → mcp-server:3002** (consistent with `/` → web-ui and `/api` → api-server).
   The mcp-server sets permissive CORS itself. TLS via the existing managed cert.
   - The web UI's connection snippet points clients at `https://<host>/mcp`, so the public
     path must be exactly `/mcp`.
3. Image build: add `mcp-server` to `build-images.yml` if it isn't already published.

## Notes / safety

- App ships independently; until this lands, remote MCP just isn't reachable (no security
  exposure — the gate is on the unexposed port).
- No new secrets required (reuses Neo4j creds). No GSM container needed for this brief.
- Project `ship-it-ai-portal`, cluster `shipit-demo`, namespace `shipit`.
