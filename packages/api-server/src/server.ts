import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import type { Redis } from 'ioredis';
import type { Config } from '@shipit-ai/shared';
import { errorHandler } from './middleware/error-handler.js';
import { registerRequireAuth } from './middleware/require-auth.js';
import { RedisSessionStore } from './services/auth/redis-session-store.js';
import { AuthStateStore } from './services/auth/state-store.js';
import { OidcProvider } from './services/auth/oidc-provider.js';
import { GitHubProvider } from './services/auth/github-provider.js';
import { TokenService } from './services/auth/token-service.js';
import authRoutes from './routes/auth.js';
import tokenRoutes from './routes/tokens.js';
import { ConnectorRegistry } from './services/connector-registry.js';
import { SchemaService } from './services/schema-service.js';
import { GitHubAppService } from './services/github-app-service.js';
import { GitHubAppManifestService } from './services/github-app-manifest-service.js';
import type { Neo4jService } from './services/neo4j-service.js';
import healthRoutes from './routes/health.js';
import connectorRoutes from './routes/connectors.js';
import schemaRoutes from './routes/schema.js';
import graphRoutes from './routes/graph.js';
import queryRoutes from './routes/query.js';
import claimsRoutes, { conflictsRoutes } from './routes/claims.js';
import teamsRoutes from './routes/teams.js';
import reconciliationRoutes from './routes/reconciliation.js';
import incidentEventsRoutes from './routes/incident-events.js';
import mcpRoutes from './routes/mcp.js';

export interface CreateServerOptions {
  logger?: boolean;
  schemaService?: SchemaService;
  connectorRegistry?: ConnectorRegistry;
  githubAppService?: GitHubAppService;
  githubAppManifestService?: GitHubAppManifestService;
  neo4jService?: Neo4jService;
  config?: Config;
  // Path to shipit.config.local.yaml. Used when no registry is supplied so
  // the server can construct one bound to the right file. Tests can omit
  // this and rely on the injected registry instead.
  localConfigPath?: string;
  // Redis client used by the session store. Required when
  // accessControl.auth.enabled is true. Tests can pass an ioredis-mock
  // instance; production wires the same Redis used for connector run
  // history. When auth is disabled (the local-dev default), the session
  // store is not registered and this can be omitted.
  redis?: Redis;
  // Override providers for tests. Production lets createServer construct
  // the real OIDC / GitHub provider modules from config; mocks can pass
  // their own to avoid hitting any real IdP.
  oidcProvider?: OidcProvider;
  githubProvider?: GitHubProvider;
  // Override the TokenService for tests. Production constructs one over
  // the Neo4j driver when auth is enabled AND a neo4jService is supplied.
  tokenService?: TokenService;
}

class AuthConfigError extends Error {
  constructor(message: string) {
    super(`accessControl.auth: ${message}`);
    this.name = 'AuthConfigError';
  }
}

// Boot-time invariants that Zod can't easily express. Throwing here makes
// a misconfigured production deployment fail loud at startup rather than
// silently accepting requests without auth, or rejecting every request
// because a critical knob is missing.
function assertAuthConfigBootable(config: Config, env: NodeJS.ProcessEnv): void {
  const auth = config.accessControl.auth;
  if (!auth.enabled) return;

  const oidcEnabled = auth.providers.oidc.enabled;
  const githubEnabled = auth.providers.github.enabled;
  if (!oidcEnabled && !githubEnabled) {
    throw new AuthConfigError(
      'auth is enabled but no provider is enabled. Set providers.oidc.enabled or providers.github.enabled to true.',
    );
  }

  if (auth.admins.length === 0) {
    throw new AuthConfigError(
      'auth is enabled but admins[] is empty. Add at least one admin email so the first deployment is usable.',
    );
  }

  const secretEnv = auth.session.signingSecretEnv;
  const secretValue = env[secretEnv];
  if (!secretValue || secretValue.length < 32) {
    throw new AuthConfigError(
      `session signing secret env var "${secretEnv}" must be set and at least 32 characters long.`,
    );
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
  }
}

export async function createServer(opts: CreateServerOptions = {}): Promise<FastifyInstance> {
  const server = Fastify({
    logger: opts.logger ?? false,
  });

  if (opts.config) {
    server.decorate('config', opts.config);
    assertAuthConfigBootable(opts.config, process.env);
  }

  const authEnabled = opts.config?.accessControl.auth.enabled ?? false;

  // Accept plain text bodies for YAML schema endpoints
  server.addContentTypeParser('text/plain', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });
  server.addContentTypeParser('text/yaml', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });
  server.addContentTypeParser('application/x-yaml', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  // CORS. With auth enabled, lock the origin list down to what the operator
  // explicitly configured and enable credentials so the session cookie
  // round-trips across the web-UI → api-server hop (different ports in dev,
  // potentially different subdomains in prod). With auth disabled the
  // permissive `origin: true` keeps the existing local-dev workflow intact —
  // there's no session to protect.
  if (authEnabled) {
    const allowedOrigins = opts.config?.accessControl.web.allowedOrigins ?? [];
    await server.register(cors, {
      origin: allowedOrigins,
      credentials: true,
    });
  } else {
    await server.register(cors, { origin: true });
  }

  // Session + cookie plugins ride along when auth is enabled. The Redis
  // session store reuses the api-server's existing ioredis client; tests
  // and disabled-auth deployments skip the registration entirely so the
  // boot path doesn't require Redis when auth isn't in play.
  if (authEnabled) {
    if (!opts.redis) {
      throw new AuthConfigError('redis client is required when auth.enabled is true.');
    }
    const sessionSecret = process.env[opts.config!.accessControl.auth.session.signingSecretEnv]!;
    await server.register(cookie);
    await server.register(session, {
      secret: sessionSecret,
      cookieName: opts.config!.accessControl.auth.session.cookieName,
      store: new RedisSessionStore({
        redis: opts.redis,
        defaultTtlSeconds: opts.config!.accessControl.auth.session.ttlHours * 60 * 60,
      }),
      cookie: {
        httpOnly: true,
        sameSite: opts.config!.accessControl.auth.session.sameSite,
        // `secure: true` is forced in production regardless of the
        // configured value — cleartext session cookies are not safe over
        // unencrypted transports. Tests and developer laptops keep the
        // configured default (still `true` unless deliberately set to
        // `false`) so a misconfigured local-prod-like setup still fails
        // closed.
        secure:
          process.env.NODE_ENV === 'production'
            ? true
            : opts.config!.accessControl.auth.session.secure,
        maxAge: opts.config!.accessControl.auth.session.ttlHours * 60 * 60 * 1000,
      },
      saveUninitialized: false,
    });

    // Construct providers (or accept overrides from tests). The callback
    // URL is derived from frontend.api.url since that's the canonical
    // public origin the web-UI hits — operators register the same URL
    // with their IdP. Provider modules are skipped when their respective
    // `providers.<id>.enabled` flag is false so disabled providers don't
    // need their secret env vars populated.
    const publicBaseUrl = opts.config!.frontend.api.url.replace(/\/$/, '');
    const stateStore = new AuthStateStore(opts.redis);
    server.decorate('authStateStore', stateStore);

    if (opts.oidcProvider) {
      server.decorate('oidcProvider', opts.oidcProvider);
    } else if (opts.config!.accessControl.auth.providers.oidc.enabled) {
      const oidcCfg = opts.config!.accessControl.auth.providers.oidc;
      const oidcSecret = process.env[oidcCfg.clientSecretEnv];
      if (!oidcSecret) {
        throw new AuthConfigError(`OIDC clientSecretEnv "${oidcCfg.clientSecretEnv}" is not set.`);
      }
      server.decorate(
        'oidcProvider',
        new OidcProvider(
          opts.config!.accessControl.auth,
          oidcSecret,
          `${publicBaseUrl}/api/auth/callback/oidc`,
        ),
      );
    }

    if (opts.githubProvider) {
      server.decorate('githubProvider', opts.githubProvider);
    } else if (opts.config!.accessControl.auth.providers.github.enabled) {
      const ghCfg = opts.config!.accessControl.auth.providers.github;
      const ghSecret = process.env[ghCfg.clientSecretEnv];
      if (!ghSecret) {
        throw new AuthConfigError(`GitHub clientSecretEnv "${ghCfg.clientSecretEnv}" is not set.`);
      }
      server.decorate(
        'githubProvider',
        new GitHubProvider(
          opts.config!.accessControl.auth,
          ghSecret,
          `${publicBaseUrl}/api/auth/callback/github`,
        ),
      );
    }

    // TokenService persists access tokens as _AccessToken nodes in Neo4j.
    // It's only useful when a Neo4j service is wired; tests can inject a
    // mock. Without Neo4j, /api/tokens returns 503 (TOKENS_DISABLED) and
    // the require-auth Bearer path falls through to TOKEN_AUTH_DISABLED.
    if (opts.tokenService) {
      server.decorate('tokenService', opts.tokenService);
    } else if (opts.neo4jService) {
      server.decorate('tokenService', new TokenService({ neo4j: opts.neo4jService }));
    }
  }

  // Global rate limit. Conservative defaults (200 req/min per IP) protect
  // the expensive endpoints (probe, manifest exchange, installations
  // listing — they hit the filesystem, the GitHub API, or both) from
  // accidental loops and abusive scans. CodeQL js/missing-rate-limiting
  // requires *some* limiter on routes that do FS access + authorization.
  // Routes can override via { config: { rateLimit: {...} } } when they
  // need tighter or looser bounds.
  await server.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    // Skip during tests so the suite isn't tracking per-IP counters
    // across hundreds of injected requests.
    enableDraftSpec: true,
  });
  await server.register(swagger, {
    openapi: {
      info: { title: 'ShipIt-AI API', version: '0.1.0' },
    },
  });

  // Auth boundary. With auth disabled this preHandler synthesizes a
  // principal from frontend.devUser and lets every request through (the
  // existing local-dev flow). With auth enabled it enforces the resolution
  // order documented in require-auth.ts: public allow-list → bearer token
  // (Stage B5) → session cookie → 401. Registered directly so the hook
  // reaches every route rather than being confined to a plugin's
  // encapsulation context.
  registerRequireAuth(server);

  server.setErrorHandler(errorHandler);

  // Decorate with services. The registry needs a localConfigPath to write
  // back to; if neither a registry nor a path is provided (e.g. unit tests
  // that don't touch persistence), fall back to a throwaway path inside
  // /tmp so a stray write doesn't clobber the real local file.
  const registry =
    opts.connectorRegistry ??
    new ConnectorRegistry({
      localConfigPath:
        opts.localConfigPath ?? `/tmp/shipit-connectors-${process.pid}-${Date.now()}.yaml`,
      initial: opts.config?.connectors.instances ?? [],
    });
  server.decorate('connectorRegistry', registry);
  server.decorate('schemaService', opts.schemaService ?? new SchemaService('./shipit-schema.yaml'));
  // GitHubAppService is optional — tests that don't touch the global App
  // routes can skip it, and the routes return 503 if it's not decorated.
  if (opts.githubAppService) {
    server.decorate('githubAppService', opts.githubAppService);
  }
  // Manifest service is also optional. Requires githubAppService to be
  // present (it persists via that service), so callers must wire both
  // together — see api-server/src/index.ts for the production bootstrap.
  if (opts.githubAppManifestService) {
    server.decorate('githubAppManifestService', opts.githubAppManifestService);
  }
  if (opts.neo4jService) {
    server.decorate('neo4jService', opts.neo4jService);
  }

  // Register routes
  await server.register(healthRoutes, { prefix: '/api' });
  await server.register(authRoutes, { prefix: '/api/auth' });
  if (authEnabled) {
    await server.register(tokenRoutes, { prefix: '/api/tokens' });
  }
  await server.register(connectorRoutes, { prefix: '/api/connectors' });
  await server.register(schemaRoutes, { prefix: '/api/schema' });

  if (opts.neo4jService) {
    await server.register(graphRoutes, { prefix: '/api/graph' });
    await server.register(queryRoutes, { prefix: '/api/query' });
    await server.register(claimsRoutes, { prefix: '/api/claims' });
    await server.register(conflictsRoutes, { prefix: '/api/conflicts' });
    await server.register(teamsRoutes, { prefix: '/api/teams' });
    await server.register(reconciliationRoutes, { prefix: '/api/reconciliation' });
  }

  // Incident-mode dashboard view log. Doesn't require Neo4j — useful for
  // adoption analytics from day one, even when running the API standalone.
  await server.register(incidentEventsRoutes, { prefix: '/api/incident-events' });

  // MCP server metadata (auth status, tool catalog). Surface for the in-app
  // /configure/mcp page; also useful for future CLI/plugin discovery.
  await server.register(mcpRoutes, { prefix: '/api/mcp' });

  return server;
}
