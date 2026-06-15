import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthPrincipal, AuthRole } from '@shipit-ai/shared';
import type { OidcProvider } from '../services/auth/oidc-provider.js';
import type { GitHubProvider } from '../services/auth/github-provider.js';
import { GitHubAccessDeniedError } from '../services/auth/github-provider.js';
import type { AuthStateStore } from '../services/auth/state-store.js';
import { buildLoginPersonEntity, type LoginIdentity } from '../services/person-upsert.js';

declare module 'fastify' {
  interface FastifyInstance {
    oidcProvider?: OidcProvider;
    githubProvider?: GitHubProvider;
    authStateStore?: AuthStateStore;
  }
}

// Note: the oidcSettingsService decoration and its declare module augmentation
// live in server.ts alongside CreateServerOptions. It is imported via the
// FastifyInstance augmentation there; no re-declaration needed here.

type ProviderId = 'oidc' | 'github';

const SUCCESS_REDIRECT = '/';
const SAFE_REDIRECT_PREFIX = '/';

// Block protocol-relative redirects like `//evil.example.com/...`. The
// callback validates against this so a malicious `redirect_to` query
// parameter can't bounce a logged-in user to an external host.
function sanitizeRedirect(raw: string | undefined): string {
  if (!raw) return SUCCESS_REDIRECT;
  if (!raw.startsWith(SAFE_REDIRECT_PREFIX)) return SUCCESS_REDIRECT;
  if (raw.startsWith('//')) return SUCCESS_REDIRECT;
  return raw;
}

// Build the `/login?error=<CODE>&redirect_to=<path>` URL the callback
// uses when an OAuth round-trip fails. Browser navigations land on this
// page rather than seeing a raw JSON error body; the login page's
// `describeCallbackError` already maps each CODE to a user-facing line.
// `redirect_to` is preserved so a successful re-auth lands the user
// where they originally wanted to go.
function buildLoginErrorRedirect(errorCode: string, redirectTo?: string): string {
  const params = new URLSearchParams({ error: errorCode });
  if (redirectTo && redirectTo !== SUCCESS_REDIRECT) {
    params.set('redirect_to', redirectTo);
  }
  return `/login?${params.toString()}`;
}

// Role and allow-list checks take every email the IdP vouches for —
// GitHub returns all verified addresses, OIDC just the one claim. Matching
// any of them means the operator's wizard-entered admin email works even
// when it isn't the user's GitHub primary.
function resolveRole(emails: ReadonlyArray<string>, admins: ReadonlyArray<string>): AuthRole {
  const lowered = emails.map((e) => e.toLowerCase());
  return admins.some((a) => lowered.includes(a.toLowerCase())) ? 'admin' : 'member';
}

function emailPassesAllowList(
  emails: ReadonlyArray<string>,
  allowList: ReadonlyArray<string>,
): boolean {
  if (allowList.length === 0) return true;
  const lowered = emails.map((e) => e.toLowerCase());
  return allowList.some((a) => lowered.includes(a.toLowerCase()));
}

// Capabilities granted by role today. Real RBAC is a follow-up; until then
// admins get the wildcard and members get the read-only set. The shape of
// this function is the seam future grants will hang off of.
function capabilitiesForRole(role: AuthRole): ReadonlyArray<string> {
  if (role === 'admin') return ['*'];
  return ['graph:read', 'catalog:read'];
}

const authRoutes: FastifyPluginAsync = async (server) => {
  const config = server.config;
  const auth = config?.accessControl.auth;

  // /me is registered in BOTH modes — it's the single endpoint the web-UI
  // calls to learn the current principal. When auth is disabled,
  // require-auth's preHandler has already populated request.ctx with the
  // dev-fallback principal synthesized from frontend.devUser. When auth
  // is enabled, require-auth either populated ctx from the session or
  // emitted a 401 before this handler runs. Either way the handler reads
  // a single source: request.ctx.
  //
  // team / joinedAt aren't on AuthPrincipal because real OIDC providers
  // don't return them, but the dev-fallback path has them in config — we
  // pluck them out here so the local-dev profile page renders the full
  // identity card.
  server.get('/me', async (request) => {
    const base = { user: request.ctx.user, org: request.ctx.org };
    if (request.ctx.user.provider !== 'dev-fallback') return base;
    const devUser = request.server.config?.frontend.devUser;
    if (!devUser) return base;
    return {
      user: {
        ...request.ctx.user,
        team: devUser.team,
        joinedAt: devUser.joinedAt,
      },
      org: base.org,
    };
  });

  // PUT /api/auth/providers/oidc — operator pastes externally-registered
  // OIDC client credentials; the secret persists via the SecretStore
  // (GSM in prod), identifiers via local YAML. Admin-only: this mutates
  // instance-wide auth config.
  //
  // Note: /api/auth/providers is in the public allow-list (exact match,
  // no trailing slash). /api/auth/providers/oidc is NOT public, so
  // require-auth applies. In auth-disabled mode the dev-fallback principal
  // has role 'admin' and passes the role check; in auth-enabled mode a
  // valid session with role 'admin' is required.
  server.put<{ Body: { issuerUrl?: string; clientId?: string; clientSecret?: string } }>(
    '/providers/oidc',
    async (request, reply) => {
      if (request.ctx.user.role !== 'admin') {
        return reply.status(403).send({
          error: { code: 'FORBIDDEN', message: 'Admin role required.' },
        });
      }
      const svc = server.oidcSettingsService;
      if (!svc) {
        return reply.status(503).send({
          error: {
            code: 'OIDC_SETTINGS_DISABLED',
            message: 'OIDC settings persistence is not wired on this deployment.',
          },
        });
      }
      const { restartRequired } = await svc.update({
        issuerUrl: request.body?.issuerUrl ?? '',
        clientId: request.body?.clientId ?? '',
        clientSecret: request.body?.clientSecret,
      });
      return reply.send({ ok: true, restartRequired });
    },
  );

  if (!auth?.enabled) {
    // Auth disabled — register only /providers (returning an empty list
    // so the web-UI login page can render "no providers configured" if
    // somehow reached) and skip the rest.
    server.get('/providers', async () => ({ providers: [] as Array<never> }));
    return;
  }

  const oidc = server.oidcProvider;
  const github = server.githubProvider;
  const stateStore = server.authStateStore;

  server.get('/providers', async () => {
    const providers: Array<{ id: ProviderId; displayName: string }> = [];
    if (auth.providers.oidc.enabled && oidc) {
      providers.push({ id: 'oidc', displayName: auth.providers.oidc.displayName });
    }
    if (auth.providers.github.enabled && github) {
      providers.push({ id: 'github', displayName: auth.providers.github.displayName });
    }
    return { providers };
  });

  server.post('/logout', async (request, reply) => {
    if (request.session) {
      await request.session.destroy();
    }
    return reply.status(204).send();
  });

  // Per-route rate limit on top of the global one (server.ts). CodeQL's
  // js/missing-rate-limiting heuristic flags authorization handlers that
  // lack a route-local limiter, and login starts are an abuse target in
  // their own right (state-store flooding, IdP redirect spam).
  server.get<{
    Params: { provider: ProviderId };
    Querystring: { redirect_to?: string };
  }>(
    '/login/:provider',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const provider = request.params.provider;
      if (provider !== 'oidc' && provider !== 'github') {
        return reply.status(404).send({
          error: { code: 'PROVIDER_NOT_FOUND', message: `Unknown auth provider: ${provider}` },
        });
      }
      if (!stateStore) {
        return reply.status(500).send({
          error: { code: 'AUTH_NOT_WIRED', message: 'Auth state store is not configured.' },
        });
      }

      const redirectTo = sanitizeRedirect(request.query.redirect_to);

      if (provider === 'oidc') {
        if (!oidc || !auth.providers.oidc.enabled) {
          return reply.status(404).send({
            error: { code: 'PROVIDER_DISABLED', message: 'OIDC provider is not configured.' },
          });
        }
        const start = await oidc.startAuthorization();
        await stateStore.put(start.state, {
          provider: 'oidc',
          codeVerifier: start.codeVerifier,
          redirectTo,
          createdAt: new Date().toISOString(),
        });
        return reply.redirect(start.url);
      }

      // github
      if (!github || !auth.providers.github.enabled) {
        return reply.status(404).send({
          error: { code: 'PROVIDER_DISABLED', message: 'GitHub provider is not configured.' },
        });
      }
      const start = github.startAuthorization();
      await stateStore.put(start.state, {
        provider: 'github',
        // GitHub OAuth Apps don't use PKCE — store an empty verifier so the
        // record shape stays uniform. Callback ignores it.
        codeVerifier: '',
        redirectTo,
        createdAt: new Date().toISOString(),
      });
      return reply.redirect(start.url);
    },
  );

  // Per-route rate limit (see /login/:provider above). Callback handlers
  // exchange the IdP authorization code for a session; an attacker who
  // grabs a code+state pair could otherwise replay it at high rate.
  server.get<{
    Params: { provider: ProviderId };
    Querystring: { code?: string; state?: string; error?: string; error_description?: string };
  }>(
    '/callback/:provider',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const provider = request.params.provider;
      const { code, state, error: idpError, error_description: idpErrorDesc } = request.query;

      // Failure branches reachable via real browser navigation redirect
      // back to `/login?error=<CODE>` so the user lands on a friendly
      // page instead of a raw JSON body. INVALID_CALLBACK and
      // AUTH_NOT_WIRED stay JSON because they only fire for
      // operator/programmer mistakes (a hand-crafted GET, a misconfigured
      // deploy), not for a real IdP round-trip — JSON is fine there.
      //
      // The `idpError`/`idpErrorDesc` query parameters are attacker-
      // controlled (an attacker could craft a `/callback/:provider?error=
      // <anything>` URL and trick a user into clicking it). The original
      // implementation echoed them into the response body, which is both
      // an XSS-adjacent surface (if any caller ever rendered the message
      // outside JSON.parse) and a log-poisoning vector (reverse proxies
      // record response bodies). We log the raw values server-side for
      // operators and emit only the fixed CODE to the browser.
      if (idpError) {
        request.log.warn(
          { idpError, idpErrorDesc, provider },
          'auth callback: identity provider returned an error',
        );
        return reply.redirect(buildLoginErrorRedirect('IDP_ERROR'));
      }
      if (!code || !state) {
        return reply.status(400).send({
          error: {
            code: 'INVALID_CALLBACK',
            message: 'Missing required code or state query parameter.',
          },
        });
      }
      if (!stateStore) {
        return reply.status(500).send({
          error: { code: 'AUTH_NOT_WIRED', message: 'Auth state store is not configured.' },
        });
      }

      const stateRecord = await stateStore.consume(state);
      if (!stateRecord || stateRecord.provider !== provider) {
        return reply.redirect(buildLoginErrorRedirect('INVALID_STATE'));
      }

      try {
        const { principal, candidateEmails, loginIdentity } = await resolvePrincipal(
          request,
          provider,
          code,
          state,
          stateRecord,
        );

        // Admins bypass the allow-list: an operator must never lock
        // themselves out of their own deployment by forgetting to add
        // their email to the guardrail list. (Role is derived from
        // admins[], matched against any verified email.)
        if (principal.role !== 'admin' && !emailPassesAllowList(candidateEmails, auth.allowList)) {
          // Email belongs to the user but they're not allow-listed. Log
          // it server-side for operators triaging access requests; do
          // not echo it to the browser response (proxies log response
          // bodies, PII shouldn't ride along).
          request.log.warn(
            { email: principal.email, provider },
            'auth callback: account is not on the access allow-list',
          );
          return reply.redirect(buildLoginErrorRedirect('NOT_ALLOWLISTED', stateRecord.redirectTo));
        }

        request.session.principal = principal;
        request.session.org = 'default';

        // Upsert the signed-in user into the graph. Best-effort and awaited
        // only so a slow bus is bounded by the publish itself; it swallows
        // its own errors and never throws, so login proceeds regardless.
        await upsertLoginPerson(request, loginIdentity);

        return reply.redirect(sanitizeRedirect(stateRecord.redirectTo));
      } catch (err) {
        if (err instanceof GitHubAccessDeniedError) {
          request.log.warn({ err, provider }, 'auth callback: access denied by provider');
          return reply.redirect(buildLoginErrorRedirect('ACCESS_DENIED', stateRecord.redirectTo));
        }
        request.log.warn({ err, provider }, 'auth callback exchange failed');
        return reply.redirect(buildLoginErrorRedirect('EXCHANGE_FAILED', stateRecord.redirectTo));
      }
    },
  );

  async function resolvePrincipal(
    request: FastifyRequest,
    provider: ProviderId,
    code: string,
    state: string,
    stateRecord: { codeVerifier: string },
  ): Promise<{
    principal: AuthPrincipal;
    candidateEmails: ReadonlyArray<string>;
    loginIdentity: LoginIdentity;
  }> {
    if (provider === 'oidc') {
      if (!oidc) throw new Error('OIDC provider not configured');
      // openid-client v6 reads the code+state out of the URL itself. We
      // rebuild the full callback URL from the request so the library can
      // do its own validation; the explicit state check uses the record
      // we just consumed from the store.
      const currentUrl = new URL(
        request.url,
        `${request.protocol}://${request.headers.host ?? 'localhost'}`,
      );
      const userInfo = await oidc.exchange(currentUrl, state, stateRecord.codeVerifier);
      const candidateEmails = [userInfo.email];
      const role = resolveRole(candidateEmails, auth!.admins);
      return {
        principal: {
          id: `oidc:${userInfo.sub}`,
          email: userInfo.email,
          displayName: userInfo.displayName,
          provider: 'oidc',
          role,
          capabilities: capabilitiesForRole(role),
        },
        candidateEmails,
        // No GitHub login → email-keyed Person (best-effort; won't merge with
        // a GitHub-connector Person). See services/person-upsert.ts.
        loginIdentity: {
          provider: 'oidc',
          sub: userInfo.sub,
          displayName: userInfo.displayName,
          email: userInfo.email,
        },
      };
    }

    if (!github) throw new Error('GitHub provider not configured');
    const userInfo = await github.exchange(code);
    // Belt-and-braces for injected test doubles that predate
    // verifiedEmails — the real provider always populates it.
    const candidateEmails = userInfo.verifiedEmails?.length
      ? userInfo.verifiedEmails
      : [userInfo.email];
    const role = resolveRole(candidateEmails, auth!.admins);
    return {
      principal: {
        id: `github:${userInfo.sub}`,
        email: userInfo.email,
        displayName: userInfo.displayName,
        provider: 'github',
        role,
        capabilities: capabilitiesForRole(role),
      },
      candidateEmails,
      // GitHub login → login-keyed Person, identical to the connector's
      // Person id, so the core-writer merges them (never duplicates).
      loginIdentity: {
        provider: 'github',
        sub: userInfo.sub,
        displayName: userInfo.displayName,
        email: userInfo.email,
        login: userInfo.login,
      },
    };
  }

  // Best-effort: publish the authenticated user as a Person so they show up in
  // the catalog/graph alongside connector-sourced people. Wrapped so a bus or
  // Redis failure can NEVER fail or delay a login — the session is already set
  // by the time this runs. No-op when the event bus isn't wired (tests,
  // Redis-less deployments).
  async function upsertLoginPerson(
    request: FastifyRequest,
    identity: LoginIdentity,
  ): Promise<void> {
    const bus = request.server.eventBus;
    if (!bus) return;
    try {
      await bus.publish([buildLoginPersonEntity(identity)], 'login');
    } catch (err) {
      request.log.warn(
        { err, provider: identity.provider },
        'login Person upsert failed (login still succeeded)',
      );
    }
  }
};

export default authRoutes;
