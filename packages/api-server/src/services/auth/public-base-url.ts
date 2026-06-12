import { AuthConfigError } from '../../auth-bootability.js';

// Derive the absolute public base URL that OAuth redirect URIs are built
// from. frontend.api.url is the canonical public origin, but behind a
// single-origin Ingress it is the path-only value `/api` — prefixing that
// directly handed GitHub a relative `/api/api/auth/callback/github` it
// rejects ("redirect_uri is not associated with this application"). A
// trailing `/api` segment is stripped because callers append the full
// `/api/...` callback path themselves; web-ui's normalizeApiBaseUrl
// applies the same normalization on its side.
export function resolvePublicBaseUrl(
  frontendApiUrl: string,
  allowedOrigins: ReadonlyArray<string>,
): string {
  const raw = frontendApiUrl.trim().replace(/\/+$/, '');
  let parsed: URL | null = null;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = null;
  }
  if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
    const path = parsed.pathname.replace(/\/+$/, '').replace(/\/api$/, '');
    return `${parsed.origin}${path}`;
  }
  // Path-only (single-origin Ingress): the web origin and the API origin
  // are the same host by construction, so the CORS allow-list holds the
  // absolute origin we need.
  const origin = allowedOrigins[0]?.trim().replace(/\/+$/, '');
  if (!origin) {
    throw new AuthConfigError(
      `frontend.api.url ("${frontendApiUrl}") is not an absolute URL and ` +
        'accessControl.web.allowedOrigins is empty — cannot derive the public ' +
        'callback URL for OAuth providers. Set frontend.api.url to the ' +
        "deployment's public origin (e.g. https://portal.example.com) or add " +
        'that origin to accessControl.web.allowedOrigins.',
    );
  }
  return origin;
}
