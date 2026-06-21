/**
 * Tests for OidcProvider — the openid-client v6 wrapper (#9, integration-test
 * roadmap). The provider was previously only ever MOCKED (auth.test.ts injects
 * a fake whose exchange() returns a canned user), so the real PKCE / state /
 * id_token-signature / userinfo contract with openid-client had ZERO coverage —
 * exactly the "OIDC login has no real test" gap #9 names.
 *
 * Strategy mirrors github-provider.test.ts: openid-client v6 talks over the
 * global `fetch`, so we stub it per-endpoint instead of standing up a server.
 * We sign a real RS256 id_token with a Node-crypto keypair and serve the
 * matching public JWK so the token is well-formed. Note openid-client does NOT
 * verify the id_token signature for the direct authorization-code token call
 * (OIDC Core §3.1.3.7 — the TLS channel to the token endpoint is trusted); what
 * it DOES enforce are the id_token claims (iss / aud / exp / iat) and the state,
 * which is what the sad-path tests below target. Self-contained: no Docker, no
 * network, no new dep.
 *
 * Sibling cookie/proxy half of #9 (the trustProxy forced-secure-cookie login
 * loop) is already covered in routes/auth.test.ts.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createPublicKey, generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import type { AuthConfig } from '@shipit-ai/shared';
import { makeTestConfig } from '../../test-config.js';
import { OidcProvider } from '../../../services/auth/oidc-provider.js';

const ISSUER = 'https://idp.test';
const CLIENT_ID = 'oidc-test-client';
const REDIRECT_URI = 'https://portal.test/api/auth/callback/oidc';
const KID = 'test-key-1';

// ── Signing key (one per module run; deterministic enough — the test asserts
// behavior, not key bytes) ────────────────────────────────────────────────
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function publicJwk(key: KeyObject): Record<string, unknown> {
  return { ...key.export({ format: 'jwk' }), kid: KID, use: 'sig', alg: 'RS256' };
}

// Sign a compact RS256 JWS over the given claims.
function signIdToken(claims: Record<string, unknown>): string {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }));
  const payload = b64url(JSON.stringify(claims));
  const signature = b64url(
    createSign('RSA-SHA256').update(`${header}.${payload}`).sign(privateKey),
  );
  return `${header}.${payload}.${signature}`;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function idTokenClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    sub: 'idp-subject-123',
    aud: CLIENT_ID,
    iat: nowSeconds(),
    exp: nowSeconds() + 3600,
    ...overrides,
  };
}

const DISCOVERY_DOC = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  userinfo_endpoint: `${ISSUER}/userinfo`,
  jwks_uri: `${ISSUER}/jwks`,
  response_types_supported: ['code'],
  subject_types_supported: ['public'],
  id_token_signing_alg_values_supported: ['RS256'],
  scopes_supported: ['openid', 'email', 'profile'],
  token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
  // Opt out of RFC 9207 so the callback URL needn't carry an `iss` param.
  authorization_response_iss_parameter_supported: false,
};

interface StubOverrides {
  idToken?: string;
  tokenResponse?: Record<string, unknown>;
  userinfo?: Record<string, unknown>;
}

// Records the outgoing token-endpoint request body so tests can assert PKCE +
// redirect_uri were actually sent. Returns the captor.
function stubIdp(overrides: StubOverrides = {}): { tokenBody: () => URLSearchParams } {
  let captured = new URLSearchParams();
  const idToken = overrides.idToken ?? signIdToken(idTokenClaims());
  const tokenResponse = overrides.tokenResponse ?? {
    access_token: 'access-tok-abc',
    token_type: 'bearer',
    id_token: idToken,
    expires_in: 3600,
  };
  const userinfo = overrides.userinfo ?? {
    sub: 'idp-subject-123',
    email: 'dev@idp.test',
    name: 'Dev User',
  };

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('.well-known/openid-configuration')) return json(DISCOVERY_DOC);
      if (url.includes('/jwks')) return json({ keys: [publicJwk(createPublicKey(publicKey))] });
      if (url.includes('/token')) {
        captured = new URLSearchParams(String(init?.body ?? ''));
        return json(tokenResponse);
      }
      if (url.includes('/userinfo')) return json(userinfo);
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );

  return { tokenBody: () => captured };
}

function makeAuthConfig(): AuthConfig {
  const auth = makeTestConfig().accessControl.auth;
  auth.providers.oidc = {
    ...auth.providers.oidc,
    enabled: true,
    issuerUrl: ISSUER,
    clientId: CLIENT_ID,
  };
  return auth;
}

function makeProvider(): OidcProvider {
  return new OidcProvider(makeAuthConfig(), 'client-secret-shh', REDIRECT_URI);
}

// Build the IdP callback URL the browser would return to.
function callbackUrl(code: string, state: string): URL {
  const u = new URL(REDIRECT_URI);
  u.searchParams.set('code', code);
  u.searchParams.set('state', state);
  return u;
}

describe('OidcProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('startAuthorization', () => {
    it('builds an authorize URL carrying PKCE S256, state, scopes, and our redirect_uri', async () => {
      stubIdp();
      const { url, state, codeVerifier } = await makeProvider().startAuthorization();

      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe(`${ISSUER}/authorize`);
      expect(parsed.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
      expect(parsed.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(parsed.searchParams.get('scope')).toBe('openid email profile');
      expect(parsed.searchParams.get('state')).toBe(state);
      expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
      expect(parsed.searchParams.get('code_challenge')).toBeTruthy();
      // The verifier is the secret kept server-side, never the challenge sent.
      expect(parsed.searchParams.get('code_challenge')).not.toBe(codeVerifier);
      expect(codeVerifier.length).toBeGreaterThan(20);
    });

    it('mints a distinct state and verifier on each call', async () => {
      stubIdp();
      const provider = makeProvider();
      const a = await provider.startAuthorization();
      const b = await provider.startAuthorization();
      expect(a.state).not.toBe(b.state);
      expect(a.codeVerifier).not.toBe(b.codeVerifier);
    });
  });

  describe('exchange', () => {
    it('completes the PKCE code exchange and returns the userinfo identity', async () => {
      const idp = stubIdp();
      const result = await makeProvider().exchange(
        callbackUrl('auth-code-xyz', 'state-abc'),
        'state-abc',
        'pkce-verifier-from-start',
      );

      expect(result).toEqual({
        sub: 'idp-subject-123',
        email: 'dev@idp.test',
        displayName: 'Dev User',
      });

      // The token request really carried the authorization code, the PKCE
      // verifier, and the SAME redirect_uri as the authorize step (the
      // authorize↔exchange redirect_uri consistency the first-login scar burned
      // us on).
      const body = idp.tokenBody();
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code')).toBe('auth-code-xyz');
      expect(body.get('code_verifier')).toBe('pkce-verifier-from-start');
      expect(body.get('redirect_uri')).toBe(REDIRECT_URI);
    });

    it('rejects a callback whose state does not match the expected state', async () => {
      stubIdp();
      await expect(
        makeProvider().exchange(
          callbackUrl('auth-code-xyz', 'tampered-state'),
          'state-abc',
          'pkce-verifier',
        ),
      ).rejects.toThrow();
    });

    it('rejects an id_token minted for a different audience (aud != our client_id)', async () => {
      // aud-binding is the claim check that stops a token issued for another
      // relying party from being replayed at this one.
      stubIdp({ idToken: signIdToken(idTokenClaims({ aud: 'some-other-client' })) });
      await expect(
        makeProvider().exchange(callbackUrl('code', 'state-abc'), 'state-abc', 'verifier'),
      ).rejects.toThrow();
    });

    it('rejects an expired id_token', async () => {
      stubIdp({
        idToken: signIdToken(idTokenClaims({ iat: nowSeconds() - 7200, exp: nowSeconds() - 3600 })),
      });
      await expect(
        makeProvider().exchange(callbackUrl('code', 'state-abc'), 'state-abc', 'verifier'),
      ).rejects.toThrow();
    });

    it('surfaces a clear error when userinfo is missing the configured email claim', async () => {
      stubIdp({ userinfo: { sub: 'idp-subject-123', name: 'No Email' } });
      await expect(
        makeProvider().exchange(callbackUrl('code', 'state-abc'), 'state-abc', 'verifier'),
      ).rejects.toThrow(/missing required `email` claim/);
    });

    it('falls back to email as displayName when userinfo has no name', async () => {
      stubIdp({ userinfo: { sub: 'idp-subject-123', email: 'noname@idp.test' } });
      const result = await makeProvider().exchange(
        callbackUrl('code', 'state-abc'),
        'state-abc',
        'verifier',
      );
      expect(result.displayName).toBe('noname@idp.test');
    });
  });
});
