'use client';

import { usePathname, useRouter } from 'next/navigation';
import { type MouseEvent } from 'react';
import { Kbd } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { useUIStore } from '@/stores/ui-store';
import { ThemeToggle } from '@/components/layout/theme-toggle';

interface Crumb {
  label: string;
  href?: string;
}

interface Trail {
  section?: Crumb;
  page: string;
}

const TRAILS: Record<string, Trail> = {
  '/': { page: 'Home' },
  '/explore': { section: { label: 'Explore' }, page: 'Graph Explorer' },
  '/ask': { section: { label: 'Explore' }, page: 'Ask' },
  '/connectors': { section: { label: 'Configure' }, page: 'Connector Hub' },
  '/incidents': { section: { label: 'Operations' }, page: 'Incident Mode' },
};

function trailFor(pathname: string): Trail {
  if (TRAILS[pathname]) return TRAILS[pathname];
  const slug = pathname.replace(/^\//, '').split('/')[0] ?? '';
  return { page: slug ? slug.charAt(0).toUpperCase() + slug.slice(1) : 'Home' };
}

export function Header() {
  const pathname = usePathname();
  const router = useRouter();
  const { setSearchOpen } = useUIStore();
  const trail = trailFor(pathname);

  return (
    <header className="border-border bg-panel grid h-14 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 border-b px-5">
      <div className="min-w-0 justify-self-start">
        <BreadcrumbTrail trail={trail} onNavigate={(href) => router.push(href)} />
      </div>

      <SearchTrigger onClick={() => setSearchOpen(true)} />

      <div className="flex justify-end">
        <ThemeToggle />
      </div>
    </header>
  );
}

function BreadcrumbTrail({
  trail,
  onNavigate,
}: {
  trail: Trail;
  onNavigate: (href: string) => void;
}) {
  const handleClick = (href: string) => (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    onNavigate(href);
  };

  return (
    <nav aria-label="Breadcrumb" className="text-[13px]">
      <ol className="m-0 flex list-none items-center gap-2 p-0">
        {trail.section && (
          <>
            <li className="text-text-muted truncate">
              {trail.section.href ? (
                <a
                  href={trail.section.href}
                  onClick={handleClick(trail.section.href)}
                  className="hover:text-text transition-colors"
                >
                  {trail.section.label}
                </a>
              ) : (
                <span>{trail.section.label}</span>
              )}
            </li>
            <li aria-hidden className="text-text-dim font-mono">
              /
            </li>
          </>
        )}
        <li className="text-text truncate font-medium" aria-current="page">
          {trail.page}
        </li>
      </ol>
    </nav>
  );
}

function SearchTrigger({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open command palette"
      className="border-border bg-panel-2 text-text-muted hover:border-border-strong hover:text-text focus-visible:ring-accent-dim flex h-10 w-full min-w-0 items-center gap-3 rounded-md border px-3 text-[13px] transition-colors outline-none focus-visible:ring-[3px] md:w-[420px]"
    >
      <span aria-hidden className="text-text-dim text-[15px] leading-none">
        <IconGlyph name="search" size={15} />
      </span>
      <span className="flex-1 truncate text-left">Search entities, services, runbooks…</span>
      <span className="hidden sm:inline-flex">
        <Kbd>⌘ K</Kbd>
      </span>
    </button>
  );
}
