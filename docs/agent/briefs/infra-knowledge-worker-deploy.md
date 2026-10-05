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
  these env vars: `DATABASE_URL` (ESO, the `shipit_app` role), `REDIS_URL`,
  `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION=global`, and the placeholders the config
  file has no fallback for, exactly as `core-writer` gets them: `NEO4J_URI`, `NEO4J_USER`,
  `NEO4J_PASSWORD`, `SHIPIT_API_URL`, `SHIPIT_WEB_ORIGIN` (no Neo4j connection is opened
  yet; the loader refuses to start with any of them unset).
- **`knowledge.enabled` must be `true` in the mounted config.** The committed
  `shipit.config.yaml` ships it `false` until the first release; with it off the worker
  logs `knowledge.enabled is false; idling` and never heartbeats, by design.
- It calls Vertex AI embeddings (`gemini-embedding-2`) with Application Default
  Credentials: run it as KSA `shipit/knowledge-worker`, bound to the GSA with
  `roles/aiplatform.user` from the pgvector brief.

## Deployment

- `Deployment`, no `Service`, `replicas: 1`. Requests around `200m / 512Mi` to start;
  embedding is network-bound.
- No readiness probe is needed; liveness can be a process check. The app's
  `/api/knowledge/status` reports a `worker` check from a Redis heartbeat
  (`shipit-knowledge-worker-heartbeat`, written every 15 s, 60 s TTL). The heartbeat is
  written only while the index loop is alive: waiting for work, or having claimed or
  finished a document in the last 15 minutes. A wedged worker therefore shows as
  `worker: not ok` within about 16 minutes; nothing restarts it by itself, so alert on that
  check if the pod should be restarted.
- `terminationGracePeriodSeconds: 30` (the Kubernetes default) is enough. On SIGTERM the
  worker aborts the embedding calls in flight and hands every document it had claimed back
  as `pending`, without counting an attempt, so the next pod takes them at once. A pod
  that is killed anyway loses nothing: its claims are reclaimed after 10 minutes.
- A document is embedded a hundred chunks at a time, and each call has a deadline (one
  minute plus three seconds per chunk, six minutes for a full hundred). A call that
  outlives it fails that document for this attempt; the worker logs `index failed for …
took longer than …` and moves on.
- Logs worth keeping: one `batch: N claimed, …` line per batch that had work.
- Start order does not matter: with the schema or the extension missing, `DATABASE_URL` or
  `GOOGLE_CLOUD_PROJECT` empty, or `knowledge.embedding.dimensions` not 768, the pod exits
  non-zero and restarts; with no documents it idles and heartbeats. Redis being down at
  boot does not stop it: it polls Postgres and picks the wake-ups up when Redis returns.
- Egress: Google APIs only. It does not call Slack, Atlassian or GitHub.

## Done when

1. With `knowledge.enabled: true` in the mounted config, the pod is `Running` and
   `kubectl logs` shows `knowledge-worker: indexing with …`.
2. `GET /api/knowledge/status` on portal-demo reports `worker: ok`.
3. The image is produced by `build-images.yml` and deployed by `deploy.yml` with the other
   services.

## Notes

- Project `ship-it-ai-portal`, cluster `shipit-demo`, namespace `shipit`.
- Please report back: the resource requests chosen and the KSA/GSA names used.
