'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ToastProvider } from '@ship-it-ui/ui';
import { AUTH_REQUIRED_EVENT } from '@/lib/api';
import '@/lib/entity-types';

// Listens once at the layout level for the shipit:auth-required event
// (fired by lib/api.ts' fetchApi on a 401). When auth is disabled the
// event should never fire — the api-server always returns the
// dev-fallback principal — but if it does, harmlessly no-ops because
// /login isn't routed when AUTH_ENABLED is false. The redirect runs only
// for pages outside /login so a 401 from inside the login flow (e.g.
// fetching /api/auth/providers on a misconfigured deployment) doesn't
// bounce in a loop.
function AuthRedirectListener({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const handler = () => {
      if (pathname?.startsWith('/login')) return;
      const next =
        pathname && pathname !== '/' ? `?redirect_to=${encodeURIComponent(pathname)}` : '';
      router.push(`/login${next}`);
    };
    window.addEventListener(AUTH_REQUIRED_EVENT, handler);
    return () => window.removeEventListener(AUTH_REQUIRED_EVENT, handler);
  }, [router, pathname]);

  return <>{children}</>;
}

export function Providers({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthRedirectListener>{children}</AuthRedirectListener>
      </ToastProvider>
    </QueryClientProvider>
  );
}
