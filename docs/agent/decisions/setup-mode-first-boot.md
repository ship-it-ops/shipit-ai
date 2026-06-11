---
type: decision
status: active
created: 2026-06-11
updated: 2026-06-11
author: claude-session-2026-06-10
tags: [auth, onboarding, setup-mode, first-boot, deploy]
importance: core
---

# First-boot SETUP MODE: trigger contract, derivation overlay, restart flip

## Context

A fresh GKE deploy was unbootable: committed `shipit.config.yaml` is
safe-by-default (auth on, no providers, `admins: []`) and
`assertAuthConfigBootable` killed the api-server before the onboarding
wizard — the thing that mints the GitHub OAuth client into GSM — could
run. Cross-repo brief 2026-06-11.

## Decision

1. **Trigger** (`shouldEnterSetupMode` in
   `packages/api-server/src/auth-bootability.ts`, a pure unit-tested
   predicate): boot into setup mode only when the bootability check fails
   AND the **`setup-completed` latch is unset** AND (`gsm` store with
   zero hydrated secrets, OR `gsm` store with every failing gate
   wizard-fixable, OR `SHIPIT_FORCE_SETUP_MODE=1` dev escape hatch).
   Gate taxonomy: `provider`/`admins` are wizard-fixable;
   `allowedOrigins`/`sessionSecret` are operator-only and always fail
   loud. The wizard-fixable widening exists so a pod restart mid-wizard
   (secrets partially persisted) re-enters setup instead of
   crash-looping.
   **The latch** (PR #59 review finding SC2): `/api/setup/complete`
   writes the one-way `setup-completed` secret (GSM container
   `shipit-setup-completed`) before replying; once set, setup mode can
   never reopen — a previously-secured deployment that later loses a
   secret (e.g. OAuth-client rotation mishap) fails loud instead of
   exposing the unauthenticated wizard to an ingress-reaching attacker.
2. **Surface**: in setup mode only `/api/health` (readiness, reports
   `mode: "setup"`), `/api/setup/*`, and the GitHub App manifest flow
   respond; everything else 401s `SETUP_MODE` (see
   `middleware/require-auth.ts` `SETUP_PUBLIC_PATHS`). Allow-listed
   requests get a synthesized `provider: 'setup'`, role-admin principal.
3. **Durability**: the first admin email is a new writable logical secret
   `auth-admin-emails` (GSM container `shipit-auth-admin-emails`,
   hydrates to `SHIPIT_AUTH_ADMINS`) — GSM because
   `shipit.config.local.yaml` is an ephemeral emptyDir in v1.
4. **Flip without config edits**: `applyDerivedAuthConfig` runs after
   every `loadConfig()` at boot — gsm + OAuth client id+secret in env →
   `providers.github.enabled = true`; `SHIPIT_AUTH_ADMINS` fills empty
   `admins[]`. `POST /api/setup/complete` re-validates a fresh load and
   then `process.exit(0)`; k8s `restartPolicy: Always` reboots into
   enforced auth.
5. **Scope v1**: GitHub provider only; OIDC stays a post-setup admin task.

## Alternatives Considered

- **Hot-swap auth in-process after wizard**: rejected — providers,
  session store, and middleware are wired at boot; restart is the clean
  boundary.
- **Manual operator restart after wizard**: rejected — brief asked for a
  no-manual-step flip.
- **Disable auth on first deploy**: rejected — violates safe-by-default.

## Consequences

- Setup mode is deliberately unauthenticated: whoever reaches the ingress
  on a genuinely-fresh deployment claims admin. Bounded by the
  401-everything-else posture and the mode permanently ending at first
  successful complete.
- **Infra dependency**: Terraform must create TWO GSM containers —
  `shipit-auth-admin-emails` AND `shipit-setup-completed` — each with pod
  GSA addVersion/access grants, before this works on-cluster.
- Un-bricking a latched deployment that legitimately needs the wizard
  again (e.g. operator wants to re-mint everything) is a deliberate
  manual step: delete the `shipit-setup-completed` versions in GSM.
- web-ui gained a public `/setup` page; login page probes `/api/health`
  and hands off to it when `mode === 'setup'`.

## Revisit Triggers

- Postgres config store lands (replaces GSM-as-config-store for admins).
- OIDC-first deployments requested → widen wizard scope.
- Multi-tenant SaaS: setup-claims-admin model must be rethought.

## Related

- [api-server-config-persistence-strategy](api-server-config-persistence-strategy.md)
- [gsm-secret-store-and-config-export](gsm-secret-store-and-config-export.md)
- [hosting-gke-distributed-not-vercel](hosting-gke-distributed-not-vercel.md)
