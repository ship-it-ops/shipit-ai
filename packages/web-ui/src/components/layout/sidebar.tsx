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
      { label: 'Ask', href: '/ask', glyph: 'ask' },
    ],
  },
  {
    label: 'Configure',
    items: [{ label: 'Connector Hub', href: '/connectors', glyph: 'bolt' }],
  },
  {
    label: 'Operations',
    items: [{ label: 'Incident Mode', href: '/incidents', glyph: 'incident' }],
  },
];

function SidebarNavItem({
  href,
  label,
  glyph,
  collapsed,
}: {
  href: string;
  label: string;
  glyph: string;
  collapsed: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const active = pathname === href || (href !== '/' && pathname.startsWith(href));

  const handleClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    router.push(href);
  };

  return (
    <NavItem
      href={href}
      icon={<IconGlyph name={glyph} size={14} />}
      label={collapsed ? '' : label}
      active={active}
      onClick={handleClick}
      title={collapsed ? label : undefined}
      aria-label={label}
    />
  );
}

export function Sidebar() {
  const { sidebarCollapsed, toggleSidebar } = useUIStore();
  const width = sidebarCollapsed ? 64 : 240;

  return (
    <DSSidebar width={width} className="gap-3">
      <BrandHeader collapsed={sidebarCollapsed} />
      <nav className="flex flex-1 flex-col gap-3 overflow-y-auto">
        {navGroups.map((group, i) => (
          <GroupBlock key={i} group={group} collapsed={sidebarCollapsed} />
        ))}
      </nav>
      <CollapseButton collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
    </DSSidebar>
  );
}

function BrandHeader({ collapsed }: { collapsed: boolean }) {
  return (
    <div className="border-border flex items-center gap-2 border-b pb-3">
      <span className="bg-accent text-on-accent grid h-8 w-8 shrink-0 place-items-center rounded-md text-[14px] font-semibold">
        S
      </span>
      {!collapsed && (
        <span className="text-text text-[14px] font-semibold tracking-tight">ShipIt-AI</span>
      )}
    </div>
  );
}

function GroupBlock({ group, collapsed }: { group: NavGroup; collapsed: boolean }) {
  if (collapsed || !group.label) {
    return (
      <div className="flex flex-col gap-[2px]">
        {group.items.map((item) => (
          <SidebarNavItem
            key={item.href}
            href={item.href}
            label={item.label}
            glyph={item.glyph}
            collapsed={collapsed}
          />
        ))}
      </div>
    );
  }
  return (
    <NavSection label={group.label}>
      {group.items.map((item) => (
        <SidebarNavItem
          key={item.href}
          href={item.href}
          label={item.label}
          glyph={item.glyph}
          collapsed={collapsed}
        />
      ))}
    </NavSection>
  );
}

function CollapseButton({
  collapsed,
  onToggle,
}: {
  collapsed: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="border-border border-t pt-2">
      <button
        type="button"
        onClick={onToggle}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        className="text-text-muted hover:text-text hover:bg-panel-2 focus-visible:ring-accent-dim rounded-xs flex w-full items-center justify-center gap-2 px-2 py-[6px] text-[12px] outline-none focus-visible:ring-[3px]"
      >
        <span aria-hidden className="font-mono text-[11px]">
          {collapsed ? '›' : '‹'}
        </span>
        {!collapsed && <span>Collapse</span>}
      </button>
    </div>
  );
}
