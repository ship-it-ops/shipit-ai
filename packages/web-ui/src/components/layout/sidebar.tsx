'use client';

import { useRouter, usePathname } from 'next/navigation';
import { type MouseEvent } from 'react';
import { Sidebar as DSSidebar, NavItem, NavSection } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { useUIStore } from '@/stores/ui-store';

interface NavLink {
  label: string;
  href: string;
  glyph: string;
  /** Optional trailing badge — e.g., 'P2' for Phase 2, 'EE' for Enterprise. */
  badge?: string;
}

interface NavGroup {
  label?: string;
  items: NavLink[];
}

const navGroups: NavGroup[] = [
  {
    items: [{ label: 'Home', href: '/', glyph: 'home' }],
  },
  {
    label: 'Explore',
    items: [
      { label: 'Graph Explorer', href: '/explore', glyph: 'graph' },
      { label: 'Query Playground', href: '/explore/query', glyph: 'cmd', badge: 'P2' },
      { label: 'Ask', href: '/ask', glyph: 'ask' },
    ],
  },
  {
    label: 'Catalog',
    items: [
      { label: 'Entities', href: '/catalog', glyph: 'document' },
      { label: 'Team Dashboard', href: '/catalog/teams', glyph: 'person', badge: 'P2' },
    ],
  },
  {
    label: 'Configure',
    items: [
      { label: 'Connector Hub', href: '/connectors', glyph: 'bolt' },
      { label: 'Schema Editor', href: '/configure/schema', glyph: 'schema', badge: 'P2' },
    ],
  },
  {
    label: 'Operations',
    items: [
      { label: 'Incident Mode', href: '/incidents', glyph: 'incident' },
      { label: 'Claim Explorer', href: '/operations/claims', glyph: 'check', badge: 'P2' },
      {
        label: 'Reconciliation',
        href: '/operations/reconciliation',
        glyph: 'graph',
        badge: 'P2',
      },
    ],
  },
  {
    label: 'Admin',
    items: [
      { label: 'Audit Log', href: '/admin/audit', glyph: 'file', badge: 'EE' },
      { label: 'Access Control', href: '/admin/access', glyph: 'settings', badge: 'EE' },
      { label: 'Agent Activity', href: '/admin/agent-activity', glyph: 'sparkle', badge: 'P3' },
    ],
  },
];

/**
 * Pick the single nav entry that should be highlighted for the current path.
 *
 * Strategy: longest-prefix wins. For `/explore/query`, both `/explore` and
 * `/explore/query` match (one by prefix, one exactly), but the longer href —
 * `/explore/query` — beats the shorter so only Query Playground highlights.
 * `/` is special-cased: it only matches when the path is exactly `/`.
 *
 * Returns the matching href, or `null` if nothing matches.
 */
function pickActiveHref(pathname: string, hrefs: ReadonlyArray<string>): string | null {
  let best: string | null = null;
  for (const href of hrefs) {
    const matches =
      href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(href + '/');
    if (matches && (!best || href.length > best.length)) {
      best = href;
    }
  }
  return best;
}

function SidebarNavItem({
  href,
  label,
  glyph,
  badge,
  collapsed,
  active,
}: {
  href: string;
  label: string;
  glyph: string;
  badge?: string;
  collapsed: boolean;
  active: boolean;
}) {
  const router = useRouter();

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    router.push(href);
  };

  if (collapsed) {
    return (
      <a
        href={href}
        onClick={handleClick}
        aria-current={active ? 'page' : undefined}
        aria-label={label}
        title={label}
        className={
          'focus-visible:ring-accent-dim grid h-10 w-10 cursor-pointer place-items-center rounded-sm outline-none transition-colors duration-(--duration-micro) focus-visible:ring-[3px] ' +
          (active
            ? 'bg-accent-dim text-accent'
            : 'text-text-muted hover:text-text hover:bg-panel-2')
        }
      >
        <IconGlyph name={glyph} size={20} />
      </a>
    );
  }

  return (
    <NavItem
      href={href}
      icon={<IconGlyph name={glyph} size={14} />}
      label={label}
      active={active}
      badge={badge}
      onClick={handleClick}
      aria-label={label}
    />
  );
}

export function Sidebar() {
  const { sidebarCollapsed, toggleSidebar } = useUIStore();
  const pathname = usePathname();
  const width = sidebarCollapsed ? 64 : 240;

  const allHrefs = navGroups.flatMap((g) => g.items.map((i) => i.href));
  const activeHref = pickActiveHref(pathname, allHrefs);

  const labeledGroups = navGroups.filter((g) => g.label);

  return (
    <DSSidebar width={width} className="gap-3">
      <BrandHeader collapsed={sidebarCollapsed} />
      <nav
        className={
          sidebarCollapsed
            ? 'flex flex-1 flex-col items-center gap-2 overflow-y-auto'
            : 'flex flex-1 flex-col gap-3 overflow-y-auto'
        }
      >
        {navGroups.map((group, i) => {
          const isLastLabeled = group.label === labeledGroups[labeledGroups.length - 1]?.label;
          return (
            <GroupBlock
              key={i}
              group={group}
              collapsed={sidebarCollapsed}
              activeHref={activeHref}
              showDivider={sidebarCollapsed && !!group.label && !isLastLabeled}
            />
          );
        })}
      </nav>
      <CollapseButton collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
    </DSSidebar>
  );
}

function BrandHeader({ collapsed }: { collapsed: boolean }) {
  return (
    <div
      className={
        collapsed
          ? 'border-border flex items-center justify-center border-b pb-3'
          : 'border-border flex items-center gap-2 border-b pb-3'
      }
    >
      <span className="bg-accent text-on-accent grid h-8 w-8 shrink-0 place-items-center rounded-md text-[14px] font-semibold">
        S
      </span>
      {!collapsed && (
        <span className="text-text text-[14px] font-semibold tracking-tight">ShipIt-AI</span>
      )}
    </div>
  );
}

function GroupBlock({
  group,
  collapsed,
  activeHref,
  showDivider,
}: {
  group: NavGroup;
  collapsed: boolean;
  activeHref: string | null;
  showDivider: boolean;
}) {
  const renderItem = (item: NavLink) => (
    <SidebarNavItem
      key={item.href}
      href={item.href}
      label={item.label}
      glyph={item.glyph}
      badge={item.badge}
      collapsed={collapsed}
      active={item.href === activeHref}
    />
  );

  if (collapsed) {
    return (
      <div className="flex w-full flex-col items-center gap-1">
        {group.items.map(renderItem)}
        {showDivider && (
          <span aria-hidden className="bg-border my-1 h-px w-6 rounded-full opacity-70" />
        )}
      </div>
    );
  }
  if (!group.label) {
    return <div className="flex flex-col gap-[2px]">{group.items.map(renderItem)}</div>;
  }
  return <NavSection label={group.label}>{group.items.map(renderItem)}</NavSection>;
}

function CollapseButton({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <div className="border-border border-t pt-2">
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="text-text-muted hover:text-text hover:bg-panel-2 focus-visible:ring-accent-dim flex w-full items-center justify-center gap-2 rounded-xs px-2 py-[6px] text-[12px] outline-none focus-visible:ring-[3px]"
      >
        <span aria-hidden className="font-mono text-[11px]">
          {collapsed ? '›' : '‹'}
        </span>
        {!collapsed && <span>Collapse</span>}
      </button>
    </div>
  );
}
