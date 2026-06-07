import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { AuthPrincipal, AuthRole } from '@shipit-ai/shared';
import type { OidcProvider } from '../services/auth/oidc-provider.js';
import type { GitHubProvider } from '../services/auth/github-provider.js';
import { GitHubAccessDeniedError } from '../services/auth/github-provider.js';
import type { AuthStateStore } from '../services/auth/state-store.js';

declare module 'fastify' {
  interface FastifyInstance {
    oidcProvider?: OidcProvider;
    githubProvider?: GitHubProvider;
    authStateStore?: AuthStateStore;
  }
}

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

function resolveRole(email: string, admins: ReadonlyArray<string>): AuthRole {
  const lowered = email.toLowerCase();
  return admins.some((a) => a.toLowerCase() === lowered) ? 'admin' : 'member';
}

function emailPassesAllowList(email: string, allowList: ReadonlyArray<string>): boolean {
  if (allowList.length === 0) return true;
  const lowered = email.toLowerCase();
  return allowList.some((a) => a.toLowerCase() === lowered);
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
        const principal = await resolvePrincipal(request, provider, code, state, stateRecord);

        if (!emailPassesAllowList(principal.email, auth.allowList)) {
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
  ): Promise<AuthPrincipal> {
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
      const role = resolveRole(userInfo.email, auth!.admins);
      return {
        id: `oidc:${userInfo.sub}`,
        email: userInfo.email,
        displayName: userInfo.displayName,
        provider: 'oidc',
        role,
        capabilities: capabilitiesForRole(role),
      };
    }

    if (!github) throw new Error('GitHub provider not configured');
    const userInfo = await github.exchange(code);
    const role = resolveRole(userInfo.email, auth!.admins);
    return {
      id: `github:${userInfo.sub}`,
      email: userInfo.email,
      displayName: userInfo.displayName,
      provider: 'github',
      role,
      capabilities: capabilitiesForRole(role),
    };
  }
};

export default authRoutes;
