import { NextResponse, type NextRequest } from 'next/server';

// Stage C2 of the auth-and-rbac milestone.
//
// When accessControl.auth.enabled is true (read from a build-time
// NEXT_PUBLIC env var injected by next.config.mjs), requests for an app
// page without a session cookie bounce to /login. When auth is disabled
// the middleware is a no-op so the existing local-dev flow keeps working
// without any IdP configured.
//
// The session cookie itself is HttpOnly + Secure, set by @fastify/session
// on the api-server. We can't read the cookie value (HttpOnly), but we
// can see whether it's PRESENT — and that's enough for "render the app
// or send them to log in." The actual authentication check happens
// server-side in the api-server's require-auth preHandler; the
// middleware just spares the user a flicker through an unauthenticated
// page before the /api/auth/me 401 fires.

const AUTH_ENABLED = process.env.NEXT_PUBLIC_SHIPIT_AUTH_ENABLED === 'true';
const COOKIE_NAME = process.env.NEXT_PUBLIC_SHIPIT_AUTH_COOKIE_NAME ?? 'shipit_sid';

// Paths the middleware lets through even without a session. /login is
// obvious; /setup hosts the first-run setup wizard, which by definition
// runs before anyone can have a session (the api-server gates it
// server-side — outside setup mode every /api/setup mutation 409s);
// /api/* never hits this middleware anyway (matcher excludes it) but the
// explicit list documents the contract; static asset paths are handled
// by the matcher.
const PUBLIC_PATHS: ReadonlyArray<string> = ['/login', '/setup'];

export function middleware(request: NextRequest): NextResponse {
  if (!AUTH_ENABLED) return NextResponse.next();

  const { pathname } = request.nextUrl;
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  if (request.cookies.get(COOKIE_NAME)) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = '/login';
  // Preserve the page the user originally wanted so the post-login
  // redirect can land them there instead of always sending them to /.
  if (pathname !== '/') {
    url.searchParams.set('redirect_to', pathname + request.nextUrl.search);
  } else {
    url.searchParams.delete('redirect_to');
  }
  return NextResponse.redirect(url);
}

// Skip API routes, Next internals, and static assets — those either
// don't render UI or are served before middleware runs anyway.
export const config = {
  matcher: ['/((?!api|_next/static|_next/image|favicon.ico|.*\\..*).*)'],
};
