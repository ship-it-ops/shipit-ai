'use client';

import { usePathname, useRouter } from 'next/navigation';
import { type MouseEvent } from 'react';
import { Topbar, Breadcrumbs, Crumb, Button, Kbd } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { useUIStore } from '@/stores/ui-store';
import { ThemeToggle } from '@/components/layout/theme-toggle';

const routeNames: Record<string, string> = {
  '/': 'Home',
  '/explore': 'Graph Explorer',
  '/connectors': 'Connector Hub',
  '/incidents': 'Incident Mode',
  '/ask': 'Ask',
};

export function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const { setSearchOpen } = useUIStore();

  const parts = pathname.split('/').filter(Boolean);

  const handleCrumbClick = (href: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    router.push(href);
  };

  const breadcrumbs =
    parts.length === 0 ? (
      <Crumb>Home</Crumb>
    ) : (
      <>
        <Crumb href="/" onClick={handleCrumbClick('/')}>
          Home
        </Crumb>
        {parts.map((part, i) => {
          const path = '/' + parts.slice(0, i + 1).join('/');
          const name = routeNames[path] ?? part.charAt(0).toUpperCase() + part.slice(1);
          const isLast = i === parts.length - 1;
          return isLast ? (
            <Crumb key={path}>{name}</Crumb>
          ) : (
            <Crumb key={path} href={path} onClick={handleCrumbClick(path)}>
              {name}
            </Crumb>
          );
        })}
      </>
    );

  return (
    <Topbar
      leading={<Breadcrumbs>{breadcrumbs}</Breadcrumbs>}
      actions={
        <>
          <Button
            variant="outline"
            size="sm"
            icon={<IconGlyph name="search" size={12} />}
            trailing={
              <span className="hidden sm:inline-flex">
                <Kbd>⌘K</Kbd>
              </span>
            }
            onClick={() => setSearchOpen(true)}
          >
            <span className="hidden sm:inline">Search</span>
          </Button>
          <ThemeToggle />
        </>
      }
    />
  );
}
