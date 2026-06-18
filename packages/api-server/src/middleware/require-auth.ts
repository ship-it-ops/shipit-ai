import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  buildCapabilitySet,
  type AuthPrincipal,
  type Config,
  type RequestContext,
  SYSTEM_CONTEXT,
} from '@shipit-ai/shared';

// The auth boundary. Every request lands here before any route handler
// runs. Resolution order:
//
//   1. accessControl.auth.enabled === false → synthesize a principal from
//      frontend.devUser. Existing local-dev flow keeps working without
//      any IdP configured.
//   2. Path matches the public allow-list (/api/health, /api/auth/*,
//      /api/mcp/info) → attach an anonymous principal so the route can
//      run without 401-ing pre-login probes.
//   3. Authorization: Bearer <token> → MCP token path. Stage B5 fills in
//      the validation; today it returns 401 with a clear "not yet
//      implemented" code so callers know it's a wiring gap, not an auth
//      failure.
//   4. request.session.principal is set (populated by /api/auth/callback
//      in Stage B4) → rebuild the RequestContext from the stored principal.
//   5. None of the above → 401.

declare module 'fastify' {
  interface FastifyRequest {
    ctx: RequestContext;
  }
  // Augmentation so request.session.principal is well-typed once Stage B4
  // sets it from the OIDC / GitHub callback. The optional field doesn't
  // exist until login completes; require-auth treats its absence as
  // "no session" and emits 401.
  interface Session {
    principal?: AuthPrincipal;
    org?: string;
  }
}

// Public paths that bypass auth even when it's enabled. /api/health
// powers external uptime checks; the specific /api/auth/* endpoints
// listed below need pre-login access so the login flow itself can run
// (providers list, login start, IdP callback, logout); /api/mcp/info is
// read by the /configure/mcp page so admins can verify their MCP setup
// before they have any token.
//
// Note: /api/auth/me is intentionally NOT public. When auth is enabled
// and the user has no session, /me should 401 (so the web-UI redirects
// to /login) — that 401 is best emitted here, not in the route handler,
// so a single code path owns the auth-required response.
const PUBLIC_PATH_PREFIXES: ReadonlyArray<string> = [
  '/api/health',
  '/api/auth/providers',
  '/api/auth/login/',
  '/api/auth/callback/',
  '/api/auth/logout',
  '/api/mcp/info',
  // GitHub webhook receiver: HMAC is the entire auth boundary (see
  // routes/webhooks.ts). Exact match, no trailing slash — only POST /github.
  '/api/webhooks/github',
];

const ANONYMOUS_PRINCIPAL: AuthPrincipal = {
  id: 'anonymous',
  email: '',
  displayName: 'Anonymous',
  provider: 'dev-fallback',
  role: 'member',
  capabilities: [],
};

// First-run setup mode: ONLY these paths respond; everything else 401s
// with SETUP_MODE — including the normal public allow-list (/api/auth/*,
// /api/mcp/info), since none of it is usable before auth is configured.
// /api/health stays up for the k8s readiness probe and the web-UI's mode
// probe; the manifest paths are the GitHub App flow the wizard drives
// (app-manifest-callback is where GitHub browser-redirects back to —
// blocking it would dead-end the flow after App creation).
const SETUP_PUBLIC_PATHS: ReadonlyArray<string> = [
  '/api/health',
  '/api/setup/',
  '/api/connectors/github/manifest',
  '/api/connectors/github/manifest/',
  '/api/connectors/github/app-manifest-callback',
  // GitHub webhook receiver: reachable during first-boot setup so the
  // receiver 202s instead of 401-storming GitHub into auto-disabling the
  // webhook before setup completes (see routes/webhooks.ts). HMAC still gates.
  '/api/webhooks/github',
];

// The allow-listed setup routes get an admin-role principal: the manifest
// flow and any future role checks on it should see the same authority the
// wizard would have post-login. Bounded by the path allow-list above and
// by setup mode itself only triggering on genuinely-fresh deployments.
const SETUP_PRINCIPAL: AuthPrincipal = {
  id: 'setup',
  email: '',
  displayName: 'First-run setup',
  provider: 'setup',
  role: 'admin',
  capabilities: ['*'],
};

function buildDevFallbackPrincipal(config: Config | undefined): AuthPrincipal {
  const devUser = config?.frontend.devUser;
  const firstName = devUser?.firstName ?? 'Dev';
  const lastName = devUser?.lastName ?? 'User';
  return {
    id: 'dev-user',
    email: devUser?.email ?? 'dev@shipit.local',
    displayName: `${firstName} ${lastName}`.trim(),
    provider: 'dev-fallback',
    role: 'admin',
    capabilities: devUser?.capabilities ?? ['*'],
  };
}

function contextFromPrincipal(
  principal: AuthPrincipal,
  org: string,
  requestId: string,
): RequestContext {
  return {
    user: principal,
    org,
    capabilities: buildCapabilitySet(principal.capabilities),
    requestId,
  };
}

function matchesAllowList(url: string, allowList: ReadonlyArray<string>): boolean {
  // Fastify's request.url includes the query string; strip it before
  // matching so /api/mcp/info?foo=bar still hits the allow-list.
  const path = url.split('?')[0] ?? url;
  return allowList.some((prefix) =>
    prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix,
  );
}

function isPublicPath(url: string): boolean {
  return matchesAllowList(url, PUBLIC_PATH_PREFIXES);
}

async function resolveContext(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<RequestContext | null> {
  const config: Config | undefined = request.server.config;
  const authEnabled = config?.accessControl.auth.enabled ?? false;
  const requestId = request.id ?? randomUUID();

  // Setup mode is checked FIRST — before the auth-disabled fallback and
  // the normal public allow-list — so the only reachable surface on a
  // fresh deployment is the wizard itself.
  if (request.server.setupMode) {
    if (matchesAllowList(request.url, SETUP_PUBLIC_PATHS)) {
      return contextFromPrincipal(SETUP_PRINCIPAL, 'default', requestId);
    }
    request.log.warn(
      { path: request.url.split('?')[0], code: 'SETUP_MODE' },
      'auth: rejected request',
    );
    reply.status(401).send({
      error: {
        code: 'SETUP_MODE',
        message: 'This deployment is in first-run setup mode. Complete setup at /setup.',
      },
    });
    return null;
  }

  if (!authEnabled) {
    return contextFromPrincipal(buildDevFallbackPrincipal(config), 'default', requestId);
  }

  if (isPublicPath(request.url)) {
    return contextFromPrincipal(ANONYMOUS_PRINCIPAL, 'default', requestId);
  }

  // Bearer token path. Tokens are minted at /api/tokens and validated by
  // TokenService against the _AccessToken nodes in Neo4j. A valid token
  // produces a principal with provider: 'mcp-token' and capabilities
  // taken from the token's stored scope list.
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const plaintext = authHeader.slice('Bearer '.length).trim();
    const tokenService = request.server.tokenService;
    if (!tokenService) {
      reply.status(503).send({
        error: {
          code: 'TOKEN_AUTH_DISABLED',
          message: 'Bearer tokens are not enabled on this deployment.',
        },
      });
      return null;
    }
    const validated = await tokenService.validate(plaintext);
    if (!validated) {
      // Log every auth rejection at warn level — production dashboards
      // can't distinguish a mis-typed token from a brute-force sweep
      // without structured signal here. Path is stripped of the query
      // string so secrets accidentally appended (e.g. ?api_key=...) don't
      // ride along into logs.
      request.log.warn(
        { path: request.url.split('?')[0], code: 'TOKEN_INVALID' },
        'auth: rejected request',
      );
      reply.status(401).send({
        error: {
          code: 'TOKEN_INVALID',
          message: 'Bearer token is invalid, revoked, or expired.',
        },
      });
      return null;
    }
    return contextFromPrincipal(
      {
        id: `token:${validated.id}`,
        email: validated.ownerEmail,
        displayName: validated.ownerEmail,
        provider: 'mcp-token',
        role: 'member',
        capabilities: validated.scopes,
      },
      'default',
      requestId,
    );
  }

  // Session cookie path. `request.session` is provided by @fastify/session
  // when the plugin is registered (server.ts only registers it with auth
  // enabled). `principal` is set by the Stage B4 callback handler.
  const principal = request.session?.principal;
  if (principal) {
    const org = request.session.org ?? 'default';
    return contextFromPrincipal(principal, org, requestId);
  }

  // Same auth-rejection log shape as the TOKEN_INVALID path above (see
  // comment there) so dashboards can bucket rejection reasons uniformly.
  request.log.warn(
    { path: request.url.split('?')[0], code: 'AUTH_REQUIRED' },
    'auth: rejected request',
  );
  reply.status(401).send({
    error: {
      code: 'AUTH_REQUIRED',
      message: 'Sign in to continue.',
    },
  });
  return null;
}

/**
 * Register the per-request auth + context plumbing on the root server.
 * Called directly (not via `server.register`) so the preHandler is
 * installed in the root scope and reaches every route rather than being
 * confined to a plugin's encapsulation context.
 *
 * The decoration uses a WeakMap-backed getter/setter so Fastify v5's
 * reference-type rule is satisfied (each request reads its own value, not
 * a shared mutable singleton) while still allowing the hook to overwrite
 * the value with `request.ctx = ...`.
 */
export function registerRequireAuth(server: FastifyInstance): void {
  const storage = new WeakMap<FastifyRequest, RequestContext>();

  server.decorateRequest('ctx', {
    getter(this: FastifyRequest) {
      return storage.get(this) ?? SYSTEM_CONTEXT;
    },
    setter(this: FastifyRequest, value: RequestContext) {
      storage.set(this, value);
    },
  });

  server.addHook('preHandler', async (request, reply) => {
    const ctx = await resolveContext(request, reply);
    if (ctx === null) {
      // resolveContext already sent the response; return without setting
      // request.ctx so downstream handlers don't run.
      return reply;
    }
    request.ctx = ctx;
    return undefined;
  });
}
