import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  buildCapabilitySet,
  type AuthPrincipal,
  type Config,
  type RequestContext,
  SYSTEM_CONTEXT,
} from '@shipit-ai/shared';

// Stage A of the auth milestone: every request gets a RequestContext
// attached so route handlers and services can be written against a stable
// shape even though the real auth boundary (Stage B's requireAuth
// preHandler) hasn't shipped yet.
//
// Resolution today is intentionally trivial:
//   - If `accessControl.auth.enabled` is false (the local-dev default),
//     synthesize a principal from `frontend.devUser` so the existing
//     onboarding wizard keeps working.
//   - Otherwise fall back to SYSTEM_CONTEXT. This branch is unreachable in
//     practice until Stage B wires up the real preHandler, because the
//     boot-time invariant rejects `auth.enabled=true` without configured
//     providers — but the safe default keeps the type-system happy and
//     means any code merged between Stage A and Stage B can't accidentally
//     ship "auth on, ctx empty".

declare module 'fastify' {
  interface FastifyRequest {
    ctx: RequestContext;
  }
}

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
    // Carry forward whatever capabilities the operator put in their config.
    // The wildcard fallback matches what `SYSTEM_CONTEXT` does for in-process
    // callers — until real RBAC lands, dev-mode is admin-by-default.
    capabilities: devUser?.capabilities ?? ['*'],
  };
}

function buildContextForRequest(request: FastifyRequest): RequestContext {
  const config: Config | undefined = request.server.config;
  const authEnabled = config?.accessControl.auth.enabled ?? false;

  if (!authEnabled) {
    const principal = buildDevFallbackPrincipal(config);
    return {
      user: principal,
      org: 'default',
      capabilities: buildCapabilitySet(principal.capabilities),
      requestId: request.id ?? randomUUID(),
    };
  }

  // Auth enabled but no preHandler has populated ctx yet — Stage B will
  // fill this in. For Stage A we hand back SYSTEM_CONTEXT so call sites
  // have a valid shape; routes that bypass the (not-yet-written) auth
  // preHandler would otherwise crash on `request.ctx.user`.
  return {
    ...SYSTEM_CONTEXT,
    requestId: request.id ?? SYSTEM_CONTEXT.requestId,
  };
}

/**
 * Register the per-request context plumbing on the root server. Called
 * directly (not via `server.register`) so the preHandler is installed in
 * the root scope and reaches every route, not just those in the plugin's
 * encapsulation.
 *
 * The decoration uses a WeakMap-backed getter/setter so Fastify v5's
 * reference-type rule is satisfied (each request reads its own value, not
 * a shared mutable singleton) while still allowing the hook to overwrite
 * the value with `request.ctx = ...`.
 */
export function registerBuildContext(server: FastifyInstance): void {
  const storage = new WeakMap<FastifyRequest, RequestContext>();

  server.decorateRequest('ctx', {
    getter(this: FastifyRequest) {
      return storage.get(this) ?? SYSTEM_CONTEXT;
    },
    setter(this: FastifyRequest, value: RequestContext) {
      storage.set(this, value);
    },
  });

  server.addHook('preHandler', async (request) => {
    request.ctx = buildContextForRequest(request);
  });
}
