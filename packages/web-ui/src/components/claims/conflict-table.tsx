'use client';

import { useMemo, useState } from 'react';
import { Badge, EmptyState, Input } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import type { ConflictRow } from '@/lib/api';

export interface ConflictTableProps {
  conflicts: ConflictRow[];
  onSelect: (row: ConflictRow) => void;
}

function tierVariant(tier: number | null) {
  if (tier === 1) return 'err' as const;
  if (tier === 2) return 'warn' as const;
  if (tier === 3) return 'neutral' as const;
  return 'neutral' as const;
}

function fmt(value: unknown): string {
  if (value === null || value === undefined) return '∅';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

export function ConflictTable({ conflicts, onSelect }: ConflictTableProps) {
  const [search, setSearch] = useState('');
  const [labelFilter, setLabelFilter] = useState<string>('');

  const labels = useMemo(() => {
    const set = new Set<string>();
    for (const c of conflicts) set.add(c.label);
    return Array.from(set).sort();
  }, [conflicts]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return conflicts.filter((c) => {
      if (labelFilter && c.label !== labelFilter) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.propertyKey.toLowerCase().includes(q) ||
        c.entityId.toLowerCase().includes(q)
      );
    });
  }, [conflicts, search, labelFilter]);

  if (conflicts.length === 0) {
    return (
      <EmptyState
        icon={<IconGlyph name="check" size={22} />}
        title="No active conflicts"
        description="Every property has a single agreed-upon value across all sources. Re-sync a connector to surface new disagreements."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="max-w-sm flex-1">
          <Input
            icon={<IconGlyph name="search" />}
            placeholder="Filter by entity, property, or id…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            size="sm"
          />
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            onClick={() => setLabelFilter('')}
            className={
              'rounded-xs border px-2 py-1 text-[11px] ' +
              (labelFilter === ''
                ? 'border-accent bg-accent-dim text-accent'
                : 'border-border text-text-muted hover:text-text')
            }
          >
            All
          </button>
          {labels.map((l) => (
            <button
              key={l}
              type="button"
              onClick={() => setLabelFilter(l)}
              className={
                'rounded-xs border px-2 py-1 text-[11px] ' +
                (labelFilter === l
                  ? 'border-accent bg-accent-dim text-accent'
                  : 'border-border text-text-muted hover:text-text')
              }
            >
              {l}
            </button>
          ))}
        </div>
        <span className="text-text-dim text-[11px]">
          {filtered.length} of {conflicts.length}
        </span>
      </div>

      <div className="border-border bg-panel rounded-base overflow-hidden border">
        <table className="text-text w-full text-[12px]">
          <thead className="bg-panel-2 text-text-muted text-left">
            <tr>
              <th className="border-border border-b px-3 py-2 font-medium">Entity</th>
              <th className="border-border border-b px-3 py-2 font-medium">Property</th>
              <th className="border-border border-b px-3 py-2 font-medium">Sources</th>
              <th className="border-border border-b px-3 py-2 font-medium">Disagreeing values</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => (
              <tr
                key={row.entityId + ':' + row.propertyKey}
                onClick={() => onSelect(row)}
                className="border-border hover:bg-panel-2/60 cursor-pointer border-b last:border-b-0"
              >
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <span className="text-text font-medium">{row.name}</span>
                    {row.tier !== null && (
                      <Badge size="sm" variant={tierVariant(row.tier)}>
                        Tier {row.tier}
                      </Badge>
                    )}
                    <Badge size="sm" variant="neutral">
                      {row.label}
                    </Badge>
                  </div>
                </td>
                <td className="px-3 py-2 font-mono text-[11px]">{row.propertyKey}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {row.sources.map((s) => (
                      <Badge key={s} size="sm" variant="accent">
                        {s}
                      </Badge>
                    ))}
                  </div>
                </td>
                <td className="text-text-muted px-3 py-2 font-mono text-[11px]">
                  {row.values.map(fmt).join('  ·  ')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
