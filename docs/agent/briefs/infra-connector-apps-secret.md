# Infra brief — add `shipit-connector-apps` GSM container + api-server IAM

**For:** `Ship-It-Ops/shipit-ai-infra` (Terraform: `terraform/modules/secret-manager`).
**From:** app repo, 2026-06-14. **Blocks:** durable per-org connectors on-cluster
(`docs/agent/decisions/connector-apps-gsm-blob-durability.md`).

## What the app does

The api-server now persists runtime-created connectors (instance config + per-org App PEM

- webhook secret) into a single GSM secret so they survive pod restarts. The app **adds
  versions** to the container and **reads** the latest; it never creates the container
  (consistent with every other secret — containers are Terraform-managed).

## Required changes

1. **New secret container** `shipit-connector-apps` (same module/pattern as
   `shipit-github-app-private-key` et al.). No initial version needed — first run with an
   absent version reads as "empty" (NOT_FOUND → null), which is handled.
2. **IAM for the api-server service account** (`shipit-api-server@<project>...`) on that
   secret:
   - `roles/secretmanager.secretVersionAdder` (write new versions), and
   - `roles/secretmanager.secretAccessor` (read latest).
     This mirrors the grants already given for the writable github-app-\* secrets — add
     `shipit-connector-apps` to the same `app_writer_secret_ids` / accessor tier.

## Notes / safety

- **Ship order is flexible**: the app-side code is safe to deploy before this lands — the
  boot read returns null (no rehydrate) and writes log a non-fatal error. Per-org
  connectors just won't be durable until the container + IAM exist.
- **Do NOT** rely on disabling/destroying versions for cleanup — the app's store treats
  only NOT_FOUND (no versions) as empty; a disabled/destroyed `latest` returns
  FAILED_PRECONDITION and would surface as a read error. (Same rule as the other secrets.)
- Size: GSM's 64KB/version cap bounds this to ~25–30 connectors; the app logs a warning
  past 60KB. If a deployment needs more, that's the trigger to move to per-connector
  containers or Postgres.
- Project: `ship-it-ai-portal` (demo). Apply to whichever environments run `SHIPIT_SECRET_STORE=gsm`.
