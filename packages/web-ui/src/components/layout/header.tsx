'use client';

import { usePathname, useRouter } from 'next/navigation';
import { type MouseEvent } from 'react';
import { Kbd } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { useUIStore } from '@/stores/ui-store';
import { UserMenu } from '@/components/layout/user-menu';

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
  '/explore/query': { section: { label: 'Explore' }, page: 'Query Playground' },
  '/ask': { section: { label: 'Explore' }, page: 'Ask' },
  '/catalog/teams': { section: { label: 'Catalog' }, page: 'Team Dashboard' },
  '/connectors': { section: { label: 'Configure' }, page: 'Connector Hub' },
  '/configure/schema': { section: { label: 'Configure' }, page: 'Schema Editor' },
  '/incidents': { section: { label: 'Operations' }, page: 'Incident Mode' },
  '/operations/claims': { section: { label: 'Operations' }, page: 'Claim Explorer' },
  '/operations/reconciliation': {
    section: { label: 'Operations' },
    page: 'Reconciliation',
  },
  '/admin/audit': { section: { label: 'Admin' }, page: 'Audit Log' },
  '/admin/access': { section: { label: 'Admin' }, page: 'Access Control' },
  '/admin/agent-activity': { section: { label: 'Admin' }, page: 'Agent Activity' },
  '/admin/settings': { section: { label: 'Admin' }, page: 'Settings' },
  '/profile': { page: 'Profile' },
  '/settings': { page: 'Settings' },
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
        <UserMenu />
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
