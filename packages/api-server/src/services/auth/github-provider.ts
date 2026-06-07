import { randomBytes } from 'node:crypto';
import type { AuthConfig } from '@shipit-ai/shared';

// "Sign in with GitHub" via a standard OAuth App (not GitHub App).
// Plain HTTP — the dance is small enough that pulling in @octokit/oauth-app
// for it would just add layers between us and the protocol. Token storage
// is short-lived and lives in process memory inside this exchange — the
// session principal is what persists across requests.

const GITHUB_AUTHORIZE_URL = 'https://github.com/login/oauth/authorize';
const GITHUB_TOKEN_URL = 'https://github.com/login/oauth/access_token';
const GITHUB_USER_URL = 'https://api.github.com/user';
const GITHUB_USER_EMAILS_URL = 'https://api.github.com/user/emails';
const GITHUB_USER_ORGS_URL = 'https://api.github.com/user/orgs';

// Cap every GitHub API call in this file. A degraded GitHub API would
// otherwise hold each server-side OAuth exchange open indefinitely; the
// four calls in `exchange()` are sequential, so one slow GitHub means a
// single login pins Fastify resources for up to 4× that delay, and
// concurrent logins stack until the server stops accepting connections
// (health checks included). AbortError surfaces to the route handler,
// which already maps non-GitHubAccessDeniedError exceptions onto the
// EXCHANGE_FAILED user-facing branch.
const GITHUB_API_TIMEOUT_MS = 5_000;

// `user:email` lets us read the authenticated user's email even if it's
// private. `read:org` is only requested when allowedOrgs is non-empty
// (asking for it unconditionally creates a scarier consent screen for
// orgs that don't need org-membership gating).
const BASE_SCOPES = ['user:email'] as const;
const ALLOWED_ORGS_SCOPES = [...BASE_SCOPES, 'read:org'] as const;

export interface GitHubUserInfo {
  /** Numeric GitHub user id (stable across rename). */
  sub: string;
  email: string;
  displayName: string;
  /** GitHub username — used for human display when name isn't set. */
  login: string;
}

export interface GitHubAuthorizationStart {
  url: string;
  state: string;
}

export class GitHubAccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubAccessDeniedError';
  }
}

export class GitHubProvider {
  private readonly authConfig: AuthConfig;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  constructor(authConfig: AuthConfig, clientSecret: string, redirectUri: string) {
    this.authConfig = authConfig;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
  }

  private get scopes(): ReadonlyArray<string> {
    return this.authConfig.providers.github.allowedOrgs.length > 0
      ? ALLOWED_ORGS_SCOPES
      : BASE_SCOPES;
  }

  startAuthorization(): GitHubAuthorizationStart {
    // GitHub OAuth doesn't support PKCE for OAuth Apps, so the state value
    // is what protects against CSRF on the callback. Use a 32-byte random
    // value — same entropy as openid-client's randomState().
    const state = randomBytes(32).toString('base64url');
    const url = new URL(GITHUB_AUTHORIZE_URL);
    url.searchParams.set('client_id', this.authConfig.providers.github.clientId);
    url.searchParams.set('redirect_uri', this.redirectUri);
    url.searchParams.set('scope', this.scopes.join(' '));
    url.searchParams.set('state', state);
    return { url: url.toString(), state };
  }

  async exchange(code: string): Promise<GitHubUserInfo> {
    const tokenRes = await fetch(GITHUB_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: this.authConfig.providers.github.clientId,
        client_secret: this.clientSecret,
        code,
        redirect_uri: this.redirectUri,
      }),
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });
    if (!tokenRes.ok) {
      throw new Error(`GitHub token endpoint returned ${tokenRes.status}`);
    }
    const tokenBody = (await tokenRes.json()) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    if (tokenBody.error || !tokenBody.access_token) {
      throw new Error(
        `GitHub OAuth error: ${tokenBody.error ?? 'no-error'} — ${tokenBody.error_description ?? 'no access_token in response'}`,
      );
    }
    const accessToken = tokenBody.access_token;

    const user = await this.fetchUser(accessToken);
    const email = await this.resolveEmail(accessToken, user);
    await this.enforceAllowedOrgs(accessToken);

    return {
      sub: String(user.id),
      email,
      displayName: user.name && user.name.length > 0 ? user.name : user.login,
      login: user.login,
    };
  }

  private async fetchUser(
    accessToken: string,
  ): Promise<{ id: number; login: string; name: string | null; email: string | null }> {
    const res = await fetch(GITHUB_USER_URL, {
      headers: this.apiHeaders(accessToken),
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`GitHub /user returned ${res.status}`);
    }
    return (await res.json()) as {
      id: number;
      login: string;
      name: string | null;
      email: string | null;
    };
  }

  private async resolveEmail(accessToken: string, user: { email: string | null }): Promise<string> {
    // Public-profile email comes back on /user. Otherwise the OAuth grant
    // gives us /user/emails which lists every verified address.
    if (user.email && user.email.length > 0) return user.email;
    const res = await fetch(GITHUB_USER_EMAILS_URL, {
      headers: this.apiHeaders(accessToken),
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`GitHub /user/emails returned ${res.status}`);
    }
    const emails = (await res.json()) as Array<{
      email: string;
      primary: boolean;
      verified: boolean;
    }>;
    const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
    if (!primary) {
      throw new GitHubAccessDeniedError(
        'No verified email on the GitHub account. Verify an email before signing in.',
      );
    }
    return primary.email;
  }

  private async enforceAllowedOrgs(accessToken: string): Promise<void> {
    const allowed = this.authConfig.providers.github.allowedOrgs;
    if (allowed.length === 0) return;
    const res = await fetch(GITHUB_USER_ORGS_URL, {
      headers: this.apiHeaders(accessToken),
      signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`GitHub /user/orgs returned ${res.status}`);
    }
    const orgs = (await res.json()) as Array<{ login: string }>;
    const memberOf = new Set(orgs.map((o) => o.login.toLowerCase()));
    const allowedLower = allowed.map((o) => o.toLowerCase());
    if (!allowedLower.some((o) => memberOf.has(o))) {
      throw new GitHubAccessDeniedError(
        `GitHub account is not a member of any allowed org (${allowed.join(', ')}).`,
      );
    }
  }

  private apiHeaders(accessToken: string): Record<string, string> {
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${accessToken}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'shipit-ai-api-server',
    };
  }
}
