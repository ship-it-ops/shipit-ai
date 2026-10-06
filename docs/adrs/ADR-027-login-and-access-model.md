# ADR-027: Login and Access Model — OAuth App for Sign-In, Allow-List with Admin Bypass, Two Roles, No Tenant Read Isolation

## Status

Accepted

## Date

2026-06-14 (allow-list: 2026-06-12; read model: 2026-06-25)

## Context

The first deployment minted one GitHub App through the manifest flow and used it both for "Sign in with GitHub" and as the connector App. That made the login client vulnerable to being overwritten by a connector creation, and a GitHub App user token cannot read a user's email addresses without a permission the manifest did not carry. The instance was also reachable by any GitHub user with a verified email, and the question of what a signed-in user may see had been left as a plumbed-but-unused seam.

## Decision

- **Sign-in uses a classic GitHub OAuth App**, created by the operator and entered in the setup wizard (`POST /api/setup/oauth`); the GitHub App manifest flow is connector-only. OIDC providers are configured after setup by an admin (`PUT /api/auth/providers/oidc`).
- **An email allow-list** (secret `auth-allow-list-emails`, env `SHIPIT_AUTH_ALLOWLIST`) limits who may sign in; any verified email of the user counts; admins bypass it so operators cannot lock themselves out. Empty means everyone may sign in. Org-membership gating (`allowedOrgs`) exists beside it.
- **Two roles.** Admins hold the wildcard capability. Members hold `graph:read`, `catalog:read`, `graph:write` (manual claims), `agents:read` and `agents:run`. Connector and knowledge-container mutations, and raw Cypher (ADR-036), need the admin role. A bearer token is always a member whose capabilities are its scopes.
- **No tenant read isolation.** A signed-in user sees every org, connector and entity. A GitHub connector is scoped to one org, so the source-connector facet is the per-org view. The `ctx.org` seam stays a permanent no-op until a customer needs isolation.

## Consequences

### Positive

- Login and connector credentials are separate; a connector change can no longer break sign-in.
- Operators manage who may sign in with a secret version and a restart, no deploy.

### Negative

- Creating the OAuth App is a manual step; GitHub has no manifest flow for OAuth Apps.
- Multi-tenant data isolation is explicitly out of scope until the access model changes.

### Neutral

- Capabilities are a seam for real role management later; today they derive from the role.

## Alternatives Considered

### Keep the GitHub App for login and add the email permission

- **Cons:** Every installation must re-approve the App; login and connector stay entangled.

### A per-tenant Cypher predicate on `_source_org`

- **Cons:** The product is shared visibility for authenticated users; isolation is not wanted.

## References

- `docs/agent/decisions/auth-oauth-app-separate-from-connector.md`, `gsm-backed-login-allowlist.md`, `no-tenant-read-isolation-authenticated-sees-all.md`
- `packages/api-server/src/routes/auth.ts`, `packages/api-server/src/middleware/require-auth.ts`
