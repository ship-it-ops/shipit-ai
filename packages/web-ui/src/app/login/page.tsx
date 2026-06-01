'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button, Card, EmptyState, Spinner } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { clientConfig } from '@/lib/client-config';

// Stage C2 of the auth-and-rbac milestone. The login page is reached by:
//   - the middleware when an unauthenticated user hits any protected route
//   - the user-menu sign-out after a successful POST /api/auth/logout
//   - a direct visit to /login
//
// We fetch /api/auth/providers (public, allow-listed in require-auth) to
// learn which IdP buttons to render. Each button does a full-page
// navigation to /api/auth/login/<provider> on the api-server, which
// redirects to the IdP. After the round-trip, /api/auth/callback sets
// the session cookie and bounces back to `/` (or the optional
// redirect_to query that the middleware forwarded).

interface ProviderListItem {
  id: 'oidc' | 'github';
  displayName: string;
}

interface ProvidersResponse {
  providers: ReadonlyArray<ProviderListItem>;
}

const PROVIDER_ICONS = {
  oidc: 'lock',
  github: 'github',
} as const satisfies Record<ProviderListItem['id'], string>;

function LoginInner() {
  const params = useSearchParams();
  const redirectTo = params.get('redirect_to') ?? '/';
  const [providers, setProviders] = useState<ProviderListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${clientConfig.api.url}/api/auth/providers`, {
          credentials: 'include',
        });
        if (!res.ok) throw new Error(`providers ${res.status}`);
        const body = (await res.json()) as ProvidersResponse;
        if (!cancelled) setProviders([...body.providers]);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load sign-in options');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSignIn = (providerId: ProviderListItem['id']) => {
    // Full-page navigation — the OAuth flow needs to bounce through the
    // IdP's hostname, which an in-app fetch can't do. The api-server
    // /login route accepts redirect_to so the user lands where they
    // were originally trying to go.
    const target = new URL(
      `${clientConfig.api.url}/api/auth/login/${providerId}`,
      window.location.href,
    );
    target.searchParams.set('redirect_to', redirectTo);
    window.location.href = target.toString();
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4">
        <div className="space-y-2 text-center">
          <h1 className="text-text text-[20px] font-semibold tracking-tight">Sign in to ShipIt</h1>
          <p className="text-text-muted text-[13px]">
            Pick a sign-in method to continue. Your administrator configures the available
            providers.
          </p>
        </div>

        <Card>
          {error && (
            <EmptyState
              tone="err"
              icon={<IconGlyph name="warn" size={22} />}
              title="Couldn't load sign-in options"
              description={error}
            />
          )}

          {!error && providers === null && (
            <div className="flex items-center justify-center gap-2 py-8">
              <Spinner size="sm" />
              <span className="text-text-dim text-[12px]">Loading sign-in options…</span>
            </div>
          )}

          {!error && providers !== null && providers.length === 0 && (
            <EmptyState
              tone="warn"
              icon={<IconGlyph name="warn" size={22} />}
              title="No sign-in providers configured"
              description="No identity providers are enabled in shipit.config. Ask your administrator to enable OIDC or GitHub OAuth under accessControl.auth.providers."
            />
          )}

          {!error && providers !== null && providers.length > 0 && (
            <div className="flex flex-col gap-2">
              {providers.map((provider) => (
                <Button
                  key={provider.id}
                  variant="primary"
                  icon={<IconGlyph name={PROVIDER_ICONS[provider.id]} />}
                  onClick={() => handleSignIn(provider.id)}
                >
                  Continue with {provider.displayName}
                </Button>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

// useSearchParams must be wrapped in <Suspense> when rendered in the
// App Router; the outer page provides the boundary.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}
