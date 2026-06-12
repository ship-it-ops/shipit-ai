import { AuthConfigError } from '../../auth-bootability.js';

// Trailing-slash strip without a regex: `/\/+$/` is CodeQL's
// js/polynomial-redos pattern (config-controlled input, so low real risk,
// but the scanning gate fails on it).
function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

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
  const raw = stripTrailingSlashes(frontendApiUrl.trim());
  let parsed: URL | null = null;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = null;
  }
  if (parsed && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
    const path = stripTrailingSlashes(parsed.pathname).replace(/\/api$/, '');
    return `${parsed.origin}${path}`;
  }
  // Path-only (single-origin Ingress): the web origin and the API origin
  // are the same host by construction, so the CORS allow-list holds the
  // absolute origin we need.
  const origin = stripTrailingSlashes(allowedOrigins[0]?.trim() ?? '');
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
