import type { Metadata } from 'next';
import { cookies } from 'next/headers';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import './globals.css';
import { Providers } from '@/components/providers';
import { Sidebar } from '@/components/layout/sidebar';
import { Header } from '@/components/layout/header';
import { GlobalCommandPalette } from '@/components/layout/global-command-palette';
import { THEME_COOKIE_NAME } from '@/lib/theme-cookie';

export const metadata: Metadata = {
  title: 'ShipIt-AI',
  description: 'AI-Ready Knowledge Graph Builder for Software Ecosystems',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const theme = cookies().get(THEME_COOKIE_NAME)?.value === 'light' ? 'light' : 'dark';

  return (
    <html lang="en" data-theme={theme === 'light' ? 'light' : undefined} suppressHydrationWarning>
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
