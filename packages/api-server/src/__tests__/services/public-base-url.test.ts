import { describe, it, expect } from 'vitest';
import { resolvePublicBaseUrl } from '../../services/auth/public-base-url.js';
import { AuthConfigError } from '../../auth-bootability.js';

// The OAuth redirect_uri sent to GitHub/OIDC must be an absolute public
// URL. frontend.api.url is the natural source, but single-origin Ingress
// deployments set it to the path-only value `/api` — naively prefixing
// that produced the relative, doubled `/api/api/auth/callback/github`
// GitHub rejects with "redirect_uri is not associated with this
// application" (portal-demo first-boot, 2026-06-12).
describe('resolvePublicBaseUrl', () => {
  it('returns an absolute frontend.api.url with the trailing slash stripped', () => {
    expect(resolvePublicBaseUrl('http://localhost:3001/', ['http://localhost:3000'])).toBe(
      'http://localhost:3001',
    );
  });

  it('strips a trailing /api path segment so callbacks do not double the prefix', () => {
    expect(resolvePublicBaseUrl('https://portal.example.com/api', [])).toBe(
      'https://portal.example.com',
    );
  });

  it('preserves a non-/api path prefix on absolute URLs', () => {
    expect(resolvePublicBaseUrl('https://portal.example.com/shipit', [])).toBe(
      'https://portal.example.com/shipit',
    );
  });

  it('falls back to the first allowed web origin when the value is path-only', () => {
    expect(resolvePublicBaseUrl('/api', ['https://portal-demo.shipitops.com/'])).toBe(
      'https://portal-demo.shipitops.com',
    );
  });

  it('throws AuthConfigError when path-only and no allowed origins exist', () => {
    expect(() => resolvePublicBaseUrl('/api', [])).toThrow(AuthConfigError);
  });
});
