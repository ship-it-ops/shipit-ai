import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import session from '@fastify/session';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import type { Redis } from 'ioredis';
import type { Config, ConfigPaths, EventBusClient } from '@shipit-ai/shared';
import { errorHandler } from './middleware/error-handler.js';
import { registerRequireAuth } from './middleware/require-auth.js';
import { RedisSessionStore } from './services/auth/redis-session-store.js';
import { AuthStateStore } from './services/auth/state-store.js';
import { OidcProvider } from './services/auth/oidc-provider.js';
import { GitHubProvider } from './services/auth/github-provider.js';
import { resolvePublicBaseUrl } from './services/auth/public-base-url.js';
import { TokenService } from './services/auth/token-service.js';
import authRoutes from './routes/auth.js';
import tokenRoutes from './routes/tokens.js';
import { ConnectorRegistry } from './services/connector-registry.js';
import { SchemaService } from './services/schema-service.js';
import { ClaimService } from './services/claim-service.js';
import { ManualEditService } from './services/manual-edit-service.js';
import { RelationEditService } from './services/relation-edit-service.js';
import { GitHubAppService } from './services/github-app-service.js';
import { GitHubAppManifestService } from './services/github-app-manifest-service.js';
import { OidcSettingsService } from './services/auth/oidc-settings-service.js';
import type { Neo4jService } from './services/neo4j-service.js';
import healthRoutes from './routes/health.js';
import connectorRoutes from './routes/connectors.js';
import schemaRoutes from './routes/schema.js';
import graphRoutes from './routes/graph.js';
import queryRoutes from './routes/query.js';
import claimsRoutes, { conflictsRoutes, relationsRoutes } from './routes/claims.js';
import teamsRoutes from './routes/teams.js';
import reconciliationRoutes from './routes/reconciliation.js';
import incidentEventsRoutes from './routes/incident-events.js';
import mcpRoutes from './routes/mcp.js';
import { configExportRoutes } from './routes/config-export.js';
import { portalSettingsRoutes } from './routes/portal-settings.js';
import setupRoutes from './routes/setup.js';
import webhookRoutes, { type WebhookRefetchPort } from './routes/webhooks.js';
import { assertAuthConfigBootable, AuthConfigError } from './auth-bootability.js';
import type { SetupService } from './services/setup-service.js';
import type { SettingsService } from './services/settings-service.js';
import feedbackRoutes from './routes/feedback.js';
import type { FeedbackService } from './services/feedback-service.js';

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
  // OIDC settings persistence service. Optional: the route returns 503
  // when not wired (e.g. tests or deployments that don't need it).
  oidcSettingsService?: OidcSettingsService;
  // Paths to the base and local config files. Required for the
  // GET /api/config/export endpoint; when absent the route returns 503
  // (CONFIG_EXPORT_DISABLED). Tests and deployments that don't need the
  // export can omit it.
  configPaths?: ConfigPaths;
  // First-run setup mode (see auth-bootability.ts and index.ts). Skips
  // the bootability assert, session/provider/token wiring, and lets the
  // require-auth middleware serve only the setup allow-list.
  setupMode?: boolean;
  // Backs the /api/setup routes; they return 503 when not wired.
  setupService?: SetupService;
  // Backs the admin /api/settings hub (webhook secrets, OAuth client, admin
  // emails, allow-list). Optional: the routes return 503 when not wired.
  settingsService?: SettingsService;
  // Backs the in-app "Report a problem" widget (/api/feedback). Optional: the
  // route returns 503 when not wired or when feedback isn't configured.
  feedbackService?: FeedbackService;
  // Event bus client, exposed to routes so the login callback can publish
  // the authenticated user as a Person entity (see routes/auth.ts and
  // services/person-upsert.ts). Production passes the same BullMQ client the
  // SyncScheduler uses; routes treat it as best-effort and tolerate its
  // absence (no publish when omitted, e.g. tests or Redis-less deployments).
  eventBus?: EventBusClient;
  // Coalesced async refetch port for the GitHub webhook receiver. Optional:
  // when absent the receiver still verifies HMAC but logs + 202s on the
  // dedup/enqueue steps (so Redis-less unit servers don't break). Production
  // injects a WebhookRefetchQueue (see index.ts).
  webhookRefetch?: WebhookRefetchPort;
}

declare module 'fastify' {
  interface FastifyInstance {
    config: Config;
    oidcSettingsService?: OidcSettingsService;
    configPaths?: ConfigPaths;
    setupMode: boolean;
    setupService?: SetupService;
    settingsService?: SettingsService;
    feedbackService?: FeedbackService;
    eventBus?: EventBusClient;
    webhookRefetch?: WebhookRefetchPort;
  }
}

export async function createServer(opts: CreateServerOptions = {}): Promise<FastifyInstance> {
  const server = Fastify({
    logger: opts.logger ?? false,
    // Behind the GKE Ingress TLS terminates upstream; without this the
    // session plugin sees request.protocol === 'http' and silently skips
    // Set-Cookie for the Secure session cookie (login loops forever).
    trustProxy: opts.config?.backend.api.trustProxy ?? false,
  });

  const setupMode = opts.setupMode ?? false;
  server.decorate('setupMode', setupMode);
  if (opts.setupService) {
    server.decorate('setupService', opts.setupService);
  }
  // Settings service backs the admin /api/settings hub. Conditional decoration
  // so Fastify's duplicate-decoration guard doesn't fire across multi-server
  // tests; the routes 503 when it's absent.
  if (opts.settingsService) {
    server.decorate('settingsService', opts.settingsService);
  }
  if (opts.feedbackService) {
    server.decorate('feedbackService', opts.feedbackService);
  }

  if (opts.config) {
    server.decorate('config', opts.config);
    // Setup mode exists precisely because this assert would fail on a
    // fresh deployment — index.ts already evaluated the gates and decided
    // the failure is wizard-fixable.
    if (!setupMode) assertAuthConfigBootable(opts.config, process.env);
  }

  const authEnabled = opts.config?.accessControl.auth.enabled ?? false;
  // Setup mode serves the wizard WITHOUT sessions, providers, or token
  // auth even though auth.enabled is true in config — those are exactly
  // the pieces that can't be constructed yet. CORS below intentionally
  // stays on authEnabled: the browser-based wizard still needs the
  // configured origins with credentials.
  const enforceAuth = authEnabled && !setupMode;

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
  // explicitly configured. With auth disabled the permissive `origin: true`
  // keeps the existing local-dev workflow intact. `credentials: true` is
  // set in BOTH modes because the web-UI's fetchApi wrapper sends every
  // request with `credentials: 'include'` — without the matching
  // Access-Control-Allow-Credentials response header, the browser drops
  // the response and useCurrentUser (and every other API call) silently
  // sees a network error.
  if (authEnabled) {
    const allowedOrigins = opts.config?.accessControl.web.allowedOrigins ?? [];
    await server.register(cors, {
      origin: allowedOrigins,
      credentials: true,
    });
  } else {
    await server.register(cors, { origin: true, credentials: true });
  }

  // Session + cookie plugins ride along when auth is enforced. The Redis
  // session store reuses the api-server's existing ioredis client; tests,
  // disabled-auth deployments, and setup mode skip the registration
  // entirely so the boot path doesn't require Redis when auth isn't in play.
  if (enforceAuth) {
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
    // with their IdP. Single-origin Ingress deployments set
    // frontend.api.url to the path-only `/api`, so resolvePublicBaseUrl
    // falls back to the CORS allow-list for the absolute origin GitHub /
    // OIDC require in redirect_uri. Provider modules are skipped when
    // their respective `providers.<id>.enabled` flag is false so disabled
    // providers don't need their secret env vars populated.
    const publicBaseUrl = resolvePublicBaseUrl(
      opts.config!.frontend.api.url,
      opts.config!.accessControl.web.allowedOrigins,
    );
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
  // OIDC settings service is optional. The PUT /api/auth/providers/oidc
  // route returns 503 when not decorated. Decoration is skipped entirely
  // when the service isn't supplied so Fastify's duplicate-decoration guard
  // doesn't fire in tests that create multiple servers.
  if (opts.oidcSettingsService) {
    server.decorate('oidcSettingsService', opts.oidcSettingsService);
  }
  // Config paths for the export endpoint. Optional — route returns 503
  // when not decorated (deployments that don't expose the export).
  if (opts.configPaths) {
    server.decorate('configPaths', opts.configPaths);
  }
  if (opts.neo4jService) {
    server.decorate('neo4jService', opts.neo4jService);
    // Manual-edit write path (claims v1a). Constructed here — alongside its
    // Neo4j dependency — so the claims routes can read it off the instance.
    // ClaimService + SchemaService are the same collaborators the read path
    // uses; schemaService is already decorated above.
    server.decorate(
      'manualEditService',
      new ManualEditService(
        opts.neo4jService,
        new ClaimService(opts.neo4jService, server.schemaService),
        server.schemaService,
      ),
    );
    // Manual RELATIONS write path (v1b). Same Neo4j dependency + live schema for
    // relation-type validation; the relations routes read it off the instance.
    server.decorate(
      'relationEditService',
      new RelationEditService(opts.neo4jService, server.schemaService),
    );
  }
  // Event bus is optional. When absent the login callback simply skips the
  // best-effort Person upsert (decoration is conditional so Fastify's
  // duplicate-decoration guard doesn't fire across multi-server tests).
  if (opts.eventBus) {
    server.decorate('eventBus', opts.eventBus);
  }
  // Webhook refetch port is optional (conditional decoration so Fastify's
  // duplicate-decoration guard doesn't fire across multi-server tests). When
  // absent, the webhook route still verifies HMAC and 202s.
  if (opts.webhookRefetch) {
    server.decorate('webhookRefetch', opts.webhookRefetch);
  }

  // Register routes
  await server.register(healthRoutes, { prefix: '/api' });
  await server.register(setupRoutes, { prefix: '/api/setup' });
  await server.register(authRoutes, { prefix: '/api/auth' });
  if (enforceAuth) {
    await server.register(tokenRoutes, { prefix: '/api/tokens' });
  }
  await server.register(connectorRoutes, { prefix: '/api/connectors' });
  await server.register(schemaRoutes, { prefix: '/api/schema' });

  if (opts.neo4jService) {
    await server.register(graphRoutes, { prefix: '/api/graph' });
    await server.register(queryRoutes, { prefix: '/api/query' });
    await server.register(claimsRoutes, { prefix: '/api/claims' });
    await server.register(conflictsRoutes, { prefix: '/api/conflicts' });
    await server.register(relationsRoutes, { prefix: '/api/relations' });
    await server.register(teamsRoutes, { prefix: '/api/teams' });
    await server.register(reconciliationRoutes, { prefix: '/api/reconciliation' });
  }

  // Incident-mode dashboard view log. Doesn't require Neo4j — useful for
  // adoption analytics from day one, even when running the API standalone.
  await server.register(incidentEventsRoutes, { prefix: '/api/incident-events' });

  // MCP server metadata (auth status, tool catalog). Surface for the in-app
  // /configure/mcp page; also useful for future CLI/plugin discovery.
  await server.register(mcpRoutes, { prefix: '/api/mcp' });

  // Config export — admin-only download of the merged raw config (pre-env-
  // substitution) for committing as the next deploy's seed config.
  await server.register(configExportRoutes, { prefix: '/api/config' });

  // Admin Portal Settings hub — webhook secret generate/rotate, OAuth client,
  // admin emails, login allow-list. Every handler is admin-gated; the routes
  // 503 when the backing SettingsService/SetupService aren't wired.
  await server.register(portalSettingsRoutes, { prefix: '/api/settings' });

  // In-app "Report a problem" widget — files a GitHub issue via a server-held
  // service PAT. Any signed-in user; the route 503s when feedback isn't wired
  // or configured.
  await server.register(feedbackRoutes, { prefix: '/api/feedback' });

  // GitHub webhook receiver. Registered as its own encapsulated plugin so its
  // route-scoped raw-body parser (HMAC needs the exact bytes) doesn't leak
  // into the global JSON parsing. HMAC is the entire auth boundary — the route
  // is in require-auth's PUBLIC_PATH_PREFIXES + SETUP_PUBLIC_PATHS.
  await server.register(webhookRoutes, { prefix: '/api/webhooks' });

  return server;
}
