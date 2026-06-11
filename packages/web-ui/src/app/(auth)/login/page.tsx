'use client';

import Image from 'next/image';
import { Suspense, useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Button, Card, Spinner } from '@ship-it-ui/ui';
import { IconGlyph, type GlyphName } from '@ship-it-ui/icons';
import { clientConfig } from '@/lib/client-config';
import { fetchHealthMode } from '@/lib/setup';

// The /login surface is reached by:
//   - the edge middleware when an unauthenticated request hits a
//     protected page (NEXT_PUBLIC_SHIPIT_AUTH_ENABLED === 'true')
//   - the layout-level 401 listener in <Providers>, which fires when
//     any API call (including /api/auth/me) returns 401
//   - a direct visit, or the user-menu's sign-out
//
// /api/auth/providers is the only request we make from here. It's on
// the api-server's public allow-list so the page renders even when the
// caller has no session.

interface ProviderListItem {
  id: 'oidc' | 'github';
  displayName: string;
}

interface ProvidersResponse {
  providers: ReadonlyArray<ProviderListItem>;
}

// State machine — keeping the union explicit so the renderer can't
// accidentally show a button list while still loading, or a spinner
// next to an error.
type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; providers: ReadonlyArray<ProviderListItem> }
  | { kind: 'no-providers' }
  | { kind: 'unreachable'; detail: string }
  | { kind: 'server-error'; status: number };

const PROVIDER_ICONS = {
  oidc: 'lock',
  github: 'github',
} as const satisfies Record<ProviderListItem['id'], string>;

// Map an api-server JSON error body — when reachable — to a short,
// human-facing line. We treat unknown codes as a generic "Sign-in
// failed" rather than echoing IdP internals.
function describeCallbackError(code: string | null): string | null {
  if (!code) return null;
  switch (code) {
    case 'NOT_ALLOWLISTED':
      return 'Your account is not on the access allow-list. Ask an administrator to add you.';
    case 'ACCESS_DENIED':
      return 'Your account does not have access to this deployment.';
    case 'INVALID_STATE':
      return 'Sign-in attempt expired before it completed. Please try again.';
    case 'IDP_ERROR':
      return 'Your identity provider rejected the sign-in attempt.';
    case 'EXCHANGE_FAILED':
      return "Couldn't finish signing you in. Try again or contact your administrator.";
    default:
      return 'Sign-in failed. Please try again.';
  }
}

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const redirectTo = params.get('redirect_to') ?? '/';
  const callbackError = describeCallbackError(params.get('error'));

  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const firstButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    let cancelled = false;

    // Any failure to list providers can mean the api-server is in
    // first-run SETUP MODE (it 401s /api/auth/providers there). Probe
    // /api/health — which setup mode keeps public — before rendering a
    // fallback error, and hand off to the setup wizard if so. Runs
    // BEFORE the build-time no-providers hint: setup mode is the more
    // specific, actionable diagnosis.
    const settleVia = async (fallback: () => void) => {
      const mode = await fetchHealthMode();
      if (cancelled) return;
      if (mode === 'setup') {
        router.replace('/setup');
        return;
      }
      fallback();
    };

    (async () => {
      try {
        const res = await fetch(`${clientConfig.api.url}/api/auth/providers`, {
          credentials: 'include',
        });
        if (!res.ok) {
          await settleVia(() => setState({ kind: 'server-error', status: res.status }));
          return;
        }
        const body = (await res.json()) as ProvidersResponse;
        if (cancelled) return;
        if (body.providers.length === 0) {
          await settleVia(() => setState({ kind: 'no-providers' }));
        } else {
          setState({ kind: 'ready', providers: [...body.providers] });
        }
      } catch (err) {
        // fetch() rejects with TypeError on network-level failures —
        // api-server down, refused connection, CORS preflight blocked.
        // Before declaring it an outage, consult the build-time YAML
        // hint: if the operator enabled auth but didn't enable any
        // provider, the api-server fails closed at boot (see
        // assertAuthConfigBootable in api-server/src/auth-bootability.ts).
        // In that case the network failure is a symptom, not the root
        // cause, and "no providers configured" is the actionable
        // diagnosis.
        if (cancelled) return;
        await settleVia(() => {
          if (clientConfig.auth.enabled && clientConfig.auth.providersEnabled.length === 0) {
            setState({ kind: 'no-providers' });
            return;
          }
          const detail = err instanceof Error ? err.message : 'Unknown network error';
          setState({ kind: 'unreachable', detail });
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // Move keyboard focus onto the first provider button as soon as the
  // buttons render — saves a Tab for keyboard users coming from the
  // middleware redirect.
  useEffect(() => {
    if (state.kind === 'ready') firstButtonRef.current?.focus();
  }, [state.kind]);

  const handleSignIn = (providerId: ProviderListItem['id']) => {
    // Full-page navigation: the OAuth flow has to leave our origin.
    // The api-server /login route accepts redirect_to so the user
    // lands back where they originally wanted after the round-trip.
    const target = new URL(
      `${clientConfig.api.url}/api/auth/login/${providerId}`,
      window.location.href,
    );
    target.searchParams.set('redirect_to', redirectTo);
    window.location.href = target.toString();
  };

  return (
    <div className="w-full max-w-[400px] space-y-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <Image
          src="/ShipItLogo.png"
          alt=""
          width={48}
          height={48}
          priority
          className="rounded-lg"
        />
        <div className="space-y-1.5">
          <h1 className="text-text text-[22px] font-semibold tracking-tight">Sign in to ShipIt</h1>
          <p className="text-text-muted text-[13px] leading-relaxed">
            Authenticate to access your portal.
          </p>
        </div>
      </div>

      {callbackError && (
        <div
          role="alert"
          aria-live="polite"
          className="border-err bg-err/10 text-err rounded-md border px-3 py-2 text-[12.5px]"
        >
          {callbackError}
        </div>
      )}

      <Card className="p-5">
        <LoginBody state={state} firstButtonRef={firstButtonRef} onSignIn={handleSignIn} />
      </Card>

      <p className="text-text-dim text-center text-[11.5px]">
        Trouble signing in? Contact your ShipIt administrator.
      </p>
    </div>
  );
}

interface LoginBodyProps {
  state: LoadState;
  firstButtonRef: React.RefObject<HTMLButtonElement | null>;
  onSignIn: (providerId: ProviderListItem['id']) => void;
}

function LoginBody({ state, firstButtonRef, onSignIn }: LoginBodyProps) {
  if (state.kind === 'loading') {
    return (
      <div className="flex items-center justify-center gap-2 py-6" aria-live="polite">
        <Spinner size="sm" />
        <span className="text-text-dim text-[12.5px]">Loading sign-in options…</span>
      </div>
    );
  }

  if (state.kind === 'unreachable') {
    return (
      <InlineMessage
        tone="err"
        icon="warn"
        title="Can't reach the sign-in service"
        body={
          <>
            The web UI couldn&apos;t connect to the API server at{' '}
            <code className="bg-panel rounded px-1 py-[1px] font-mono text-[11.5px]">
              {clientConfig.api.url}
            </code>
            . Check that <code>pnpm start:backend</code> is running and reload this page.
          </>
        }
      />
    );
  }

  if (state.kind === 'server-error') {
    return (
      <InlineMessage
        tone="err"
        icon="warn"
        title="Sign-in service is unavailable"
        body={
          <>
            The API server returned <strong>{state.status}</strong> when listing sign-in providers.
            Check the api-server logs and reload this page.
          </>
        }
      />
    );
  }

  if (state.kind === 'no-providers') {
    return (
      <InlineMessage
        tone="warn"
        icon="warn"
        title="No authentication providers configured"
        body={
          <>
            Sign-in is enabled in{' '}
            <code className="bg-panel rounded px-1 py-[1px] font-mono text-[11.5px]">
              shipit.config.local.yaml
            </code>
            , but no identity provider is. Enable <code>oidc</code> or <code>github</code> under{' '}
            <code className="bg-panel rounded px-1 py-[1px] font-mono text-[11.5px]">
              accessControl.auth.providers
            </code>{' '}
            and restart the backend to continue. The API server won&apos;t accept logins — or boot
            at all — until at least one provider is enabled.
          </>
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {state.providers.map((provider, idx) => (
        <Button
          key={provider.id}
          ref={idx === 0 ? firstButtonRef : undefined}
          variant="primary"
          icon={<IconGlyph name={PROVIDER_ICONS[provider.id]} />}
          onClick={() => onSignIn(provider.id)}
        >
          Continue with {provider.displayName}
        </Button>
      ))}
    </div>
  );
}

function InlineMessage({
  tone,
  icon,
  title,
  body,
}: {
  tone: 'err' | 'warn';
  icon: GlyphName;
  title: string;
  body: React.ReactNode;
}) {
  const iconWrap = tone === 'err' ? 'bg-err/10 text-err' : 'bg-warn/10 text-warn';
  return (
    <div
      role="alert"
      aria-live="polite"
      className="flex flex-col items-center gap-3 py-2 text-center"
    >
      <span className={`flex h-9 w-9 items-center justify-center rounded-md ${iconWrap}`}>
        <IconGlyph name={icon} size={18} />
      </span>
      <div className="space-y-1.5">
        <p className="text-text text-[13.5px] font-medium">{title}</p>
        <p className="text-text-muted text-[12.5px] leading-relaxed">{body}</p>
      </div>
    </div>
  );
}

// useSearchParams must live under a <Suspense> boundary in the App
// Router, so the page export wraps the inner client component.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginInner />
    </Suspense>
  );
}
