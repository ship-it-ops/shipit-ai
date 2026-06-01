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
// powers external uptime checks; /api/auth/* must be reachable pre-login
// to drive the login flow itself; /api/mcp/info is read by the
// /configure/mcp page so admins can verify their MCP setup before they
// have any token.
const PUBLIC_PATH_PREFIXES: ReadonlyArray<string> = ['/api/health', '/api/auth/', '/api/mcp/info'];

const ANONYMOUS_PRINCIPAL: AuthPrincipal = {
  id: 'anonymous',
  email: '',
  displayName: 'Anonymous',
  provider: 'dev-fallback',
  role: 'member',
  capabilities: [],
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

function isPublicPath(url: string): boolean {
  // Fastify's request.url includes the query string; strip it before
  // matching so /api/mcp/info?foo=bar still hits the allow-list.
  const path = url.split('?')[0] ?? url;
  return PUBLIC_PATH_PREFIXES.some((prefix) =>
    prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix,
  );
}

async function resolveContext(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<RequestContext | null> {
  const config: Config | undefined = request.server.config;
  const authEnabled = config?.accessControl.auth.enabled ?? false;
  const requestId = request.id ?? randomUUID();

  if (!authEnabled) {
    return contextFromPrincipal(buildDevFallbackPrincipal(config), 'default', requestId);
  }

  if (isPublicPath(request.url)) {
    return contextFromPrincipal(ANONYMOUS_PRINCIPAL, 'default', requestId);
  }

  // Bearer token path — wired up in Stage B5. Detect-and-reject keeps the
  // request from falling through to the cookie path with a half-set ctx.
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    reply.status(401).send({
      error: {
        code: 'TOKEN_AUTH_NOT_IMPLEMENTED',
        message:
          'Bearer token authentication is not yet enabled. Mint a session via /api/auth/login.',
      },
    });
    return null;
  }

  // Session cookie path. `request.session` is provided by @fastify/session
  // when the plugin is registered (server.ts only registers it with auth
  // enabled). `principal` is set by the Stage B4 callback handler.
  const principal = request.session?.principal;
  if (principal) {
    const org = request.session.org ?? 'default';
    return contextFromPrincipal(principal, org, requestId);
  }

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
