# ADR-026: First-Boot Setup Mode

## Status

Accepted

## Date

2026-06-11

## Context

The committed configuration is safe by default: authentication on, no provider, no admins. On a fresh deployment the bootability check therefore stopped the api-server before the wizard that would configure a provider could run.

## Decision

- **Trigger.** The api-server boots into setup mode only when the bootability check fails, the one-way `setup-completed` latch is unset, and the failing gates are ones the wizard can fix (provider, admins) — or `SHIPIT_FORCE_SETUP_MODE=1` in development. Operator-only gates (allowed origins, session secret) always fail loud.
- **Surface.** In setup mode only `/api/health` (reporting `mode: "setup"`), `/api/setup/*`, the GitHub App manifest flow and the webhook receiver answer; everything else returns 401 `SETUP_MODE`. The web UI's login page hands off to a public `/setup` page.
- **Durability.** The first admin's email is written to a secret (`auth-admin-emails`); the GitHub OAuth client (ADR-027) and connector credentials go to their secrets (ADR-025).
- **Flip.** `applyDerivedAuthConfig` runs after every configuration load and enables the GitHub provider when the client credentials are present. `POST /api/setup/complete` writes the latch, re-validates and exits the process; Kubernetes restarts it with authentication enforced.

## Consequences

### Positive

- A fresh deployment is usable without an operator editing configuration or restarting anything by hand.
- Once completed, setup mode can never reopen: a deployment that later loses a secret fails loud instead of exposing an unauthenticated wizard.

### Negative

- Setup mode is deliberately unauthenticated: whoever reaches the ingress of a genuinely fresh deployment claims admin. It is bounded by the 401-everything-else posture and by the latch.
- Re-running the wizard on purpose is a manual step: delete the latch's versions in the secret store.

### Neutral

- Only the GitHub provider is configured in setup; OIDC is a post-setup admin task.

## Alternatives Considered

### Hot-swap authentication in process after the wizard

- **Cons:** Providers, the session store and middleware are wired at boot; a restart is the clean boundary.

### Disable authentication on first deploy

- **Cons:** Violates safe-by-default.

## References

- `docs/agent/decisions/setup-mode-first-boot.md`
- `packages/api-server/src/auth-bootability.ts`, `packages/api-server/src/middleware/require-auth.ts`
