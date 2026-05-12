import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './globals.css';
import { ThemeBootstrap } from '@ship-it-ui/next';
import { Providers } from '@/components/providers';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { GlobalCommandPalette } from '@/components/layout/global-command-palette';

// `@ship-it-ui/next` ships a single 'use client' bundle, so its server-safe
// helpers (getThemeFromCookies) can't be invoked from a server component.
// Read the documented cookie name directly until the DS splits the entrypoint.
const THEME_COOKIE_NAME = 'ship-it-theme';

export const metadata: Metadata = {
  title: 'ShipIt-AI',
  description: 'AI-Ready Knowledge Graph Builder for Software Ecosystems',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const cookieValue = (await cookies()).get(THEME_COOKIE_NAME)?.value;
  const theme = cookieValue === 'light' ? 'light' : cookieValue === 'dark' ? 'dark' : undefined;

  return (
    <html lang="en" data-theme={theme === 'light' ? 'light' : undefined} suppressHydrationWarning>
      <head>
        <ThemeBootstrap />
      </head>
      <body className="bg-bg text-text">
        <Providers>
          <div className="flex h-screen overflow-hidden">
            <Sidebar />
            <div className="flex flex-1 flex-col overflow-hidden">
              <Header />
              <main className="flex-1 overflow-y-auto">{children}</main>
            </div>
          </div>
          <GlobalCommandPalette />
        </Providers>
      </body>
    </html>
  );
}
