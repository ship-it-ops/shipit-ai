import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import '@ship-it-ui/graph-editor/styles.css';
import './globals.css';
import { ThemeBootstrap } from '@ship-it-ui/next';
import { getThemeFromCookies } from '@ship-it-ui/next/server';
import { Providers } from '@/components/providers';

export const metadata: Metadata = {
  title: 'ShipIt-AI',
  description: 'AI-Ready Knowledge Graph Builder for Software Ecosystems',
};

// Root layout. Owns the <html>/<body> shell and the cross-cutting
// providers (theme, React Query, auth-redirect listener) that every
// surface needs. Chrome — the sidebar, header, global command palette,
// onboarding trigger — lives in `(app)/layout.tsx` so unauthenticated
// surfaces (`/login`, future `/forbidden`, `/session-expired`) can
// render bare against the same theme without the authenticated app
// frame leaking through.
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = getThemeFromCookies(await cookies());

  return (
    <html lang="en" data-theme={theme === 'light' ? 'light' : undefined} suppressHydrationWarning>
      <head>
        <ThemeBootstrap />
      </head>
      <body className="bg-bg text-text">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
