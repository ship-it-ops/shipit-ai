import { describe, it, expect, vi, afterEach } from 'vitest';
import { GitHubProvider } from '../../services/auth/github-provider.js';
import { makeTestConfig } from '../test-config.js';

// GitHubProvider talks to GitHub via global fetch (no injectable seam), so
// these tests stub it per-URL. Coverage focus: email resolution — identity
// pick, the verifiedEmails set used for role/allow-list matching, and the
// /user/emails 403 path (GitHub App missing the "Email addresses:
// Read-only" account permission — portal-demo, 2026-06-12).
function makeProvider(): GitHubProvider {
  const auth = makeTestConfig().accessControl.auth;
  auth.providers.github.clientId = 'cid';
  return new GitHubProvider(auth, 'shh', 'https://portal.example.com/api/auth/callback/github');
}

interface StubResponse {
  status: number;
  body: unknown;
}

function stubFetch(handlers: Record<string, StubResponse>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      for (const [needle, res] of Object.entries(handlers)) {
        if (url.includes(needle)) {
          return new Response(JSON.stringify(res.body), {
            status: res.status,
            headers: { 'content-type': 'application/json' },
          });
        }
      }
      throw new Error(`unexpected fetch: ${url}`);
    }),
  );
}

const TOKEN_OK: StubResponse = { status: 200, body: { access_token: 'tok' } };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GitHubProvider email resolution', () => {
  it('collects every verified email and picks the primary as identity', async () => {
    stubFetch({
      'login/oauth/access_token': TOKEN_OK,
      '/user/emails': {
        status: 200,
        body: [
          { email: 'work@company.com', primary: false, verified: true },
          { email: 'personal@example.com', primary: true, verified: true },
          { email: 'old@unverified.com', primary: false, verified: false },
        ],
      },
      '/user': { status: 200, body: { id: 7, login: 'mo', name: 'Mo', email: null } },
    });
    const info = await makeProvider().exchange('code');
    expect(info.email).toBe('personal@example.com');
    expect(info.verifiedEmails).toEqual(
      expect.arrayContaining(['personal@example.com', 'work@company.com']),
    );
    expect(info.verifiedEmails).not.toContain('old@unverified.com');
  });

  it('merges the public profile email with the verified list and keeps it as identity', async () => {
    stubFetch({
      'login/oauth/access_token': TOKEN_OK,
      '/user/emails': {
        status: 200,
        body: [{ email: 'work@company.com', primary: true, verified: true }],
      },
      '/user': { status: 200, body: { id: 7, login: 'mo', name: 'Mo', email: 'pub@example.com' } },
    });
    const info = await makeProvider().exchange('code');
    expect(info.email).toBe('pub@example.com');
    expect(info.verifiedEmails).toEqual(
      expect.arrayContaining(['pub@example.com', 'work@company.com']),
    );
  });

  it('falls back to the public profile email when /user/emails is forbidden', async () => {
    stubFetch({
      'login/oauth/access_token': TOKEN_OK,
      '/user/emails': { status: 403, body: { message: 'Resource not accessible' } },
      '/user': { status: 200, body: { id: 7, login: 'mo', name: 'Mo', email: 'pub@example.com' } },
    });
    const info = await makeProvider().exchange('code');
    expect(info.email).toBe('pub@example.com');
    expect(info.verifiedEmails).toEqual(['pub@example.com']);
  });

  it('surfaces the missing App permission when /user/emails 403s and no public email exists', async () => {
    stubFetch({
      'login/oauth/access_token': TOKEN_OK,
      '/user/emails': { status: 403, body: { message: 'Resource not accessible' } },
      '/user': { status: 200, body: { id: 7, login: 'mo', name: 'Mo', email: null } },
    });
    await expect(makeProvider().exchange('code')).rejects.toThrow(/Email addresses/);
  });
});
