'use client';

import { useEffect, useState, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { CommandPalette, type CommandPaletteGroup, type CommandPaletteItem } from '@ship-it-ui/ui';
import { DynamicIconGlyph } from '@ship-it-ui/icons';
import { getEntityTypeMeta } from '@ship-it-ui/shipit';
import { useUIStore } from '@/stores/ui-store';
import { useSearch } from '@/lib/hooks/use-search';

export function GlobalCommandPalette() {
  const router = useRouter();
  const { searchOpen, setSearchOpen } = useUIStore();
  const [query, setQuery] = useState('');
  const { data: results = [] } = useSearch(query);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(!searchOpen);
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [searchOpen, setSearchOpen]);

  useEffect(() => {
    if (!searchOpen) setQuery('');
  }, [searchOpen]);

  const groups: CommandPaletteGroup[] = useMemo(() => {
    if (query.trim().length < 2 || results.length === 0) return [];
    const byLabel = results.reduce<Record<string, CommandPaletteItem[]>>((acc, r) => {
      const meta = getEntityTypeMeta(r.label);
      const item: CommandPaletteItem = {
        id: r.id,
        label: r.name,
        description: r.owner ? `${meta.label} · ${r.owner}` : meta.label,
        glyph: (
          <span className={meta.toneClass}>
            <DynamicIconGlyph name={meta.iconName} size={14} />
          </span>
        ),
        trailing: r.label,
      };
      (acc[r.label] ??= []).push(item);
      return acc;
    }, {});
    return Object.entries(byLabel).map(([label, items]) => ({ label, items }));
  }, [query, results]);

  const handleSelect = (id: string) => {
    setSearchOpen(false);
    router.push(`/explore?focus=${id}`);
  };

  return (
    <CommandPalette
      open={searchOpen}
      onOpenChange={setSearchOpen}
      query={query}
      onQueryChange={setQuery}
      groups={groups}
      onSelect={handleSelect}
      placeholder="Search entities by name, type, or ID…"
      emptyState={
        <div className="text-text-dim px-3 py-5 text-center text-[12px]">
          {query.trim().length < 2 ? 'Type at least 2 characters to search.' : 'No results found.'}
        </div>
      }
      footer={
        <>
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span>esc close</span>
        </>
      }
    />
  );
}
