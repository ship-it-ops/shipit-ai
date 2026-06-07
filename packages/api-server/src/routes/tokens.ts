import type { FastifyPluginAsync } from 'fastify';
import { hasCapability } from '@shipit-ai/shared';
import type { TokenService } from '../services/auth/token-service.js';

declare module 'fastify' {
  interface FastifyInstance {
    tokenService?: TokenService;
  }
}

const MAX_NAME_LENGTH = 128;

// Capability scopes a user can put on a token. Today we only have
// `mcp:invoke` as the meaningful one (the MCP server checks it when a
// token is presented), but the array is open-ended so future Stage B6/D
// work can grow it without re-shipping. The set is intentionally a
// subset of the principal's own capabilities — a member can only mint
// tokens that grant capabilities they already have.
const KNOWN_TOKEN_SCOPES: ReadonlyArray<string> = ['mcp:invoke', 'graph:read', 'catalog:read'];

interface CreateTokenBody {
  name?: string;
  scopes?: string[];
}

const tokenRoutes: FastifyPluginAsync = async (server) => {
  const tokens = server.tokenService;
  if (!tokens) {
    // Auth disabled deployments don't construct a TokenService; mounting
    // an explicit 503 is friendlier than a confusing 404 if a stray
    // /api/tokens call slips through.
    server.get('*', async (_request, reply) =>
      reply.status(503).send({
        error: {
          code: 'TOKENS_DISABLED',
          message: 'Tokens require accessControl.auth.enabled to be true.',
        },
      }),
    );
    return;
  }

  server.post<{ Body: CreateTokenBody }>('/', async (request, reply) => {
    const ctx = request.ctx;
    if (!ctx.user.email) {
      return reply.status(401).send({
        error: { code: 'AUTH_REQUIRED', message: 'Sign in to mint tokens.' },
      });
    }

    const name = typeof request.body?.name === 'string' ? request.body.name.trim() : '';
    if (name.length === 0 || name.length > MAX_NAME_LENGTH) {
      return reply.status(400).send({
        error: {
          code: 'INVALID_NAME',
          message: `Token name must be 1–${MAX_NAME_LENGTH} characters.`,
        },
      });
    }

    const requestedScopes = Array.isArray(request.body?.scopes)
      ? request.body!.scopes!.filter((s) => typeof s === 'string')
      : ['mcp:invoke'];
    const unknownScope = requestedScopes.find((s) => !KNOWN_TOKEN_SCOPES.includes(s));
    if (unknownScope) {
      return reply.status(400).send({
        error: {
          code: 'UNKNOWN_SCOPE',
          message: `Unknown scope: ${unknownScope}. Allowed: ${KNOWN_TOKEN_SCOPES.join(', ')}.`,
        },
      });
    }

    // A user can't mint a token with capabilities they themselves lack.
    // Wildcards on the principal pass everything through; otherwise we
    // intersect explicitly.
    const overReach = requestedScopes.find((scope) => !hasCapability(ctx, scope));
    if (overReach) {
      return reply.status(403).send({
        error: {
          code: 'SCOPE_OUT_OF_REACH',
          message: `You don't have the ${overReach} capability, so you can't mint a token with it.`,
        },
      });
    }

    const created = await tokens.create({
      name,
      ownerEmail: ctx.user.email,
      scopes: requestedScopes,
    });

    // Return the plaintext exactly once. UI surfaces this with a "save
    // it now, you won't see it again" panel.
    return reply.status(201).send({
      id: created.id,
      name: created.name,
      token: created.plaintext,
      scopes: created.scopes,
      createdAt: created.createdAt,
    });
  });

  server.get('/', async (request, reply) => {
    const ctx = request.ctx;
    if (!ctx.user.email) {
      return reply.status(401).send({
        error: { code: 'AUTH_REQUIRED', message: 'Sign in to list tokens.' },
      });
    }
    const list = await tokens.listForOwner(ctx.user.email);
    return reply.send({
      tokens: list.map((t) => ({
        id: t.id,
        name: t.name,
        scopes: t.scopes,
        createdAt: t.createdAt,
        lastUsedAt: t.lastUsedAt,
        revoked: t.revoked,
      })),
    });
  });

  server.delete<{ Params: { id: string } }>('/:id', async (request, reply) => {
    const ctx = request.ctx;
    if (!ctx.user.email) {
      return reply.status(401).send({
        error: { code: 'AUTH_REQUIRED', message: 'Sign in to revoke tokens.' },
      });
    }
    const found = await tokens.revoke(request.params.id, ctx.user.email);
    if (!found) {
      return reply.status(404).send({
        error: { code: 'TOKEN_NOT_FOUND', message: 'No token with that id is owned by you.' },
      });
    }
    return reply.status(204).send();
  });
};

export default tokenRoutes;
