---
type: investigation
status: fixed
created: 2026-09-16
updated: 2026-09-16
author: claude-fable-5-1-session-01Au4gDpcAj93LDvrEzXqLsE
tags: [deploy, gsm, secrets, hydration, eso, iam, helm-timeout, crashloop, api-server]
importance: core
---

# `sha-e30da0f` deploy rolled back twice: api-server boot read ESO-delivered secrets from GSM without a grant

## Symptoms

- Infra `deploy.yml` runs 35054478167 and 35055382522 (2026-09-16): `helm upgrade shipit-ai
--atomic --timeout 10m` → `client rate limiter Wait returned an error: context deadline
exceeded` → rollback to the June 30 release (`sha-dcef0a6`). Site stayed up throughout.
- Cluster events: core-writer, web-ui, mcp-server rolled to the new image and were NEG-healthy
  in seconds. Only `api-server-766d599c9-*` never was: `Warning BackOff … restarting failed
container api-server` ×26, then `LoadBalancerNegTimeout`.
- Cloud Logging for those pods: boot dies with
  `Error: 7 PERMISSION_DENIED: Permission 'secretmanager.versions.access' denied on resource
(or it may not exist)` from `@google-cloud/secret-manager` as an unhandled rejection
  (`triggerUncaughtException … fromPromise`).

## Root Cause

PR #96 (config-driven secrets registry, merged 2026-07-24 — **never deployed until today**)
rewrote `packages/api-server/src/secrets/hydrate.ts` Pass 1 to iterate every `consume: env`
registry entry and `await store.read(key)` **before** looking at the env var. Two registry
entries are not the app's to fetch:

| registry key          | GSM container                | how the pod really gets it                                                          | accessor grants    |
| --------------------- | ---------------------------- | ----------------------------------------------------------------------------------- | ------------------ |
| `neo4j-aura-password` | `shipit-neo4j-aura-password` | ESO `ExternalSecret shipit-app-secrets` → k8s Secret → `envFrom` (`NEO4J_PASSWORD`) | `eso-reader@` only |
| `session-secret`      | `shipit-session-secret`      | same (`SHIPIT_SESSION_SECRET`)                                                      | `eso-reader@` only |

Infra tiers them deliberately: both are in the module's `secret_ids` (containers exist — this
is NOT the missing-container scar) but in neither `app_reader_secret_ids` nor
`app_writer_secret_ids`, so `shipit-api-server@` has no `secretAccessor`. GSM answers a
denied `accessSecretVersion` with gRPC 7, `GsmStore.read` only swallows code 5 (NOT_FOUND)
and re-throws 7 by design (a missing grant must be loud), and nothing above catches it.

The pre-#96 code (deployed `dcef0a6`) hydrated an explicit `ENV_HYDRATED` list that never
included these two, which is why the old image boots.

## Fix

`hydrate.ts` Pass 1: a **non-empty pre-set env value short-circuits the store read** —
matching the module's own contract ("pre-set env wins") and the deployment model (platform
delivers bootstrap secrets; the app fetches only wizard/feature secrets it has grants for).
Empty-string env still counts as unset and is filled from GSM (unchanged). Unit test in
`hydrate.test.ts` reproduces production (env pre-set + store throwing code 7) and was watched
failing with the exact error first.

Rejected: granting the api-server GSA `secretAccessor` on the two containers
(`app_reader_secret_ids`). Works, but widens access to secrets the app already receives via
env, against the intentional tiering.

## Prevention / Tripwire

- **Signature:** helm atomic timeout + only api-server not NEG-healthy + `BackOff` events →
  read the pod's Cloud Logging **before** touching infra; it is a boot crash, not capacity.
- Any new registry entry that the chart delivers via ESO/env must NOT expect an app grant;
  any entry the app must fetch itself needs a tier grant in infra **before** the image
  deploys (the 2026-06-30 feedback-token incident is the container-side twin of this one).
- Long gaps between merge and deploy are the enabler here (7 weeks of merged app changes
  first exercised in prod today). Deploy main more often, or run the boot path against the
  real GSM tiers in a pre-deploy check.

## Related

- [runtime-image-strips-bundled-npm-and-apk-upgrades](../decisions/runtime-image-strips-bundled-npm-and-apk-upgrades.md) — the fix that unblocked the image gate the same day
- [gsm-secret-store-and-config-export](../decisions/gsm-secret-store-and-config-export.md) — the store's read/throw contract
- infra repo: `investigations/deploy-dcef0a6-2026-06-30-spot-stockout-feedback-token-crashloop.md` (missing-container twin) and `terraform/modules/secret-manager/variables.tf` (the tiers)
