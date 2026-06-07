import {
  authorizationCodeGrant,
  buildAuthorizationUrl,
  calculatePKCECodeChallenge,
  type Configuration,
  discovery,
  fetchUserInfo,
  randomPKCECodeVerifier,
  randomState,
} from 'openid-client';
import type { AuthConfig } from '@shipit-ai/shared';

// Wraps openid-client v6 for the generic OIDC provider. v6 is function-
// based (not class-based like v5) — there's no `Client` instance to keep
// around, just a `Configuration` object that holds the issuer metadata
// and client credentials. We discover once lazily on first use and
// memoize so a slow IdP doesn't block boot.

export interface OidcUserInfo {
  /** Stable IdP subject identifier — used as the principal id. */
  sub: string;
  email: string;
  displayName: string;
}

export interface OidcAuthorizationStart {
  /** Full URL to redirect the browser to. */
  url: string;
  /** Opaque state value the caller must store and require back from the IdP. */
  state: string;
  /** PKCE verifier the caller must store and pass back to `exchange`. */
  codeVerifier: string;
}

export class OidcProvider {
  private readonly authConfig: AuthConfig;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private configurationPromise: Promise<Configuration> | null = null;

  constructor(authConfig: AuthConfig, clientSecret: string, redirectUri: string) {
    this.authConfig = authConfig;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
  }

  /**
   * Resolves the IdP's `.well-known/openid-configuration` document and
   * builds an openid-client Configuration. Memoized so we don't hit the
   * IdP on every login; throws on bad config so the failure surfaces at
   * the first request rather than as silent 500s later.
   */
  private getConfiguration(): Promise<Configuration> {
    if (!this.configurationPromise) {
      const issuer = this.authConfig.providers.oidc.issuerUrl;
      const clientId = this.authConfig.providers.oidc.clientId;
      // 10s timeout (openid-client expresses it in seconds) — without
      // this a slow or unreachable IdP would hold the discovery promise
      // open for the OS TCP timeout (several minutes), and every
      // concurrent login would block on the same dangling promise,
      // stacking Fastify worker threads. The value is stored on the
      // resolved Configuration so subsequent token-exchange / userinfo
      // calls inherit the same cap. Mirrors the GITHUB_API_TIMEOUT_MS
      // guard on the GitHub provider.
      this.configurationPromise = discovery(
        new URL(issuer),
        clientId,
        this.clientSecret,
        undefined,
        { timeout: 10 },
      ).catch((err) => {
        // Drop the cached rejection so the next request can retry once
        // the IdP is reachable again — useful when the api-server boots
        // before the IdP in docker-compose stacks.
        this.configurationPromise = null;
        throw err;
      });
    }
    return this.configurationPromise;
  }

  /**
   * Generate the authorize URL + state + PKCE verifier. Caller stores the
   * state-keyed record and redirects the browser.
   */
  async startAuthorization(): Promise<OidcAuthorizationStart> {
    const config = await this.getConfiguration();
    const codeVerifier = randomPKCECodeVerifier();
    const codeChallenge = await calculatePKCECodeChallenge(codeVerifier);
    const state = randomState();

    const url = buildAuthorizationUrl(config, {
      redirect_uri: this.redirectUri,
      scope: this.authConfig.providers.oidc.scopes.join(' '),
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return { url: url.toString(), state, codeVerifier };
  }

  /**
   * Exchange the authorization code at the callback URL for tokens, then
   * fetch userinfo. `currentUrl` is the full callback URL including the
   * code + state query params; openid-client validates state internally
   * via the `expectedState` check.
   */
  async exchange(
    currentUrl: URL,
    expectedState: string,
    codeVerifier: string,
  ): Promise<OidcUserInfo> {
    const config = await this.getConfiguration();
    const tokens = await authorizationCodeGrant(config, currentUrl, {
      expectedState,
      pkceCodeVerifier: codeVerifier,
    });

    if (!tokens.access_token) {
      throw new Error('OIDC token endpoint did not return an access_token');
    }

    // The id_token's claims aren't enough on their own — IdPs vary on
    // whether `email` ships in the id_token vs only the userinfo
    // endpoint. fetch userinfo so we get a consistent shape across
    // providers. `claims()` is openid-client's helper that returns the
    // parsed id_token claims for the subject check.
    const idTokenClaims = tokens.claims();
    if (!idTokenClaims?.sub) {
      throw new Error('OIDC id_token missing required `sub` claim');
    }

    const userInfo = await fetchUserInfo(config, tokens.access_token, idTokenClaims.sub);

    const emailClaim = this.authConfig.providers.oidc.emailClaim;
    const email = (userInfo as Record<string, unknown>)[emailClaim];
    if (typeof email !== 'string' || email.length === 0) {
      throw new Error(`OIDC userinfo missing required \`${emailClaim}\` claim`);
    }

    const name =
      typeof userInfo.name === 'string' && userInfo.name.length > 0 ? userInfo.name : email;

    return {
      sub: String(userInfo.sub),
      email,
      displayName: name,
    };
  }
}
