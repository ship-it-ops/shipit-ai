// Per-request identity + authorization context.
//
// Threaded through every Fastify route handler and every service/data-layer
// method that touches Neo4j. Even though `org` is constant in single-tenant
// today, taking the parameter now is the load-bearing change — when the SaaS
// milestone (docs/agent/plans/saas-tier-shared-github-app.md) populates it
// with a per-customer value, no signatures have to change.
//
// `capabilities` is a Set for O(1) lookup at call sites; the array form on
// `user.capabilities` is the canonical, serializable shape (used in session
// payloads, API responses, etc.).

export type AuthProvider = 'oidc' | 'github' | 'dev-fallback' | 'mcp-token';

export type AuthRole = 'admin' | 'member';

export interface AuthPrincipal {
  /** Stable IdP subject. `dev-user` in disabled-auth mode; `token:<id>` for MCP tokens. */
  id: string;
  email: string;
  displayName: string;
  provider: AuthProvider;
  role: AuthRole;
  capabilities: ReadonlyArray<string>;
}

export interface RequestContext {
  user: AuthPrincipal;
  /** Tenant slug. `default` in single-tenant; populated per-customer in SaaS. */
  org: string;
  /** Resolved from role + grants; the array on `user.capabilities` is the source. */
  capabilities: ReadonlySet<string>;
  /** Correlates server logs with a single request lifecycle. */
  requestId: string;
}

export function hasCapability(ctx: RequestContext, capability: string): boolean {
  if (ctx.capabilities.has('*')) return true;
  return ctx.capabilities.has(capability);
}

export function buildCapabilitySet(capabilities: ReadonlyArray<string>): ReadonlySet<string> {
  return new Set(capabilities);
}

// SYSTEM_CONTEXT is used in two places during the transition to real auth:
//   1. Stage A: routes and tests that haven't been wired to a real context yet
//      pass this so signatures match while behavior is unchanged.
//   2. Long-term: server-internal callers without an HTTP request (the
//      reconciliation worker, the sync scheduler) get this as their default.
//
// It has admin capabilities because the in-process callers it represents
// are trusted by construction. The auth boundary is at HTTP ingress, not
// here — anything reaching SYSTEM_CONTEXT has already been authorized by
// being part of the server process.
export const SYSTEM_CONTEXT: RequestContext = {
  user: {
    id: 'system',
    email: 'system@shipit.local',
    displayName: 'System',
    provider: 'dev-fallback',
    role: 'admin',
    capabilities: ['*'],
  },
  org: 'default',
  capabilities: new Set(['*']),
  requestId: 'system',
};
