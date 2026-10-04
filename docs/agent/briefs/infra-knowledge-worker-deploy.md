# Infra brief — `knowledge-worker` Deployment

**For:** `Ship-It-Ops/shipit-ai-infra`. **From:** app repo, 2026-10-04. **Follows:**
`infra-pgvector-for-knowledge.md` (the pgvector instance, the superuser bootstrap step, the
KSA/GSA). **Enables:** indexing for the knowledge layer
(`docs/superpowers/specs/2026-10-02-knowledge-connectors-design.md`).

You are working in the infra repo. Read its `docs/agent/MANIFEST.md`, `status/` and
`instructions/` first; its standing instructions apply.

## What exists now

- Image: `knowledge-worker`, built from `packages/knowledge-worker/Dockerfile` in the app
  repo (same shape as `core-writer`; CI builds it in the docker matrix). Add it to
  `build-images.yml`.
- It reads the mounted `shipit.config.yaml` like every other backend service and needs
  these env vars: `DATABASE_URL` (ESO, the `shipit_app` role), `REDIS_URL`, `NEO4J_URI` and
  `NEO4J_PASSWORD` (config placeholders; no Neo4j connection is opened yet),
  `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION=global`.
- It calls Vertex AI embeddings (`gemini-embedding-2`) with Application Default
  Credentials: run it as KSA `shipit/knowledge-worker`, bound to the GSA with
  `roles/aiplatform.user` from the pgvector brief.

## Deployment

- `Deployment`, no `Service`, `replicas: 1`. Requests around `200m / 512Mi` to start;
  embedding is network-bound.
- No readiness probe is needed; liveness can be a process check. The app's
  `/api/knowledge/status` reports a `worker` check from a Redis heartbeat
  (`shipit-knowledge-worker-heartbeat`, written every 15 s, 60 s TTL).
- Start order does not matter: with the schema or the extension missing the pod exits
  non-zero and restarts; with no documents it idles and heartbeats.
- Egress: Google APIs only. It does not call Slack, Atlassian or GitHub.

## Done when

1. The pod is `Running` and `kubectl logs` shows `knowledge-worker: indexing with …`.
2. `GET /api/knowledge/status` on portal-demo reports `worker: ok`.
3. The image is produced by `build-images.yml` and deployed by `deploy.yml` with the other
   services.

## Notes

- Project `ship-it-ai-portal`, cluster `shipit-demo`, namespace `shipit`.
- Please report back: the resource requests chosen and the KSA/GSA names used.
