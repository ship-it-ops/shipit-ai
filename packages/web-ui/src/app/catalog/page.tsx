'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  type BadgeProps,
  EmptyState,
  FilterPanel,
  type FilterPanelValue,
  Input,
  Spinner,
} from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { getEntityTypeMeta } from '@ship-it-ui/shipit';
import { useCatalogEntities } from '@/lib/hooks/use-graph-data';

interface CatalogRow {
  id: string;
  name: string;
  type: string;
  owner: string;
  environment: string;
  tier: string;
}

type SortKey = 'name' | 'type' | 'environment' | 'tier' | 'owner';
type SortDir = 'asc' | 'desc';

const TYPE_BADGE_VARIANT: Record<string, NonNullable<BadgeProps['variant']>> = {
  LogicalService: 'accent',
  RuntimeService: 'accent',
  Repository: 'ok',
  Deployment: 'warn',
  Pipeline: 'pink',
  Monitor: 'err',
  Team: 'purple',
  Person: 'neutral',
};

function toRow(node: { data: Record<string, unknown> }): CatalogRow {
  const d = node.data as {
    id: string;
    name?: string;
    type?: string;
    owner?: string;
    environment?: string;
    tier?: number | string;
  };
  return {
    id: d.id,
    name: d.name ?? d.id,
    type: d.type ?? 'Unknown',
    owner: d.owner ?? '',
    environment: d.environment ?? '',
    tier: d.tier !== undefined ? String(d.tier) : '',
  };
}

function uniqueSorted(values: ReadonlyArray<string>): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

function matches(row: CatalogRow, query: string, filter: FilterPanelValue): boolean {
  const q = query.trim().toLowerCase();
  if (q) {
    const haystack = `${row.name} ${row.id} ${row.type} ${row.owner}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  if (filter.types?.length && !filter.types.includes(row.type)) return false;
  if (filter.environments?.length && !filter.environments.includes(row.environment)) return false;
  if (filter.owners?.length && !filter.owners.includes(row.owner)) return false;
  if (filter.tiers?.length && !filter.tiers.includes(row.tier)) return false;
  return true;
}

function compareRows(a: CatalogRow, b: CatalogRow, key: SortKey, dir: SortDir): number {
  const av = a[key] ?? '';
  const bv = b[key] ?? '';
  const cmp = av.localeCompare(bv, undefined, { numeric: true, sensitivity: 'base' });
  return dir === 'asc' ? cmp : -cmp;
}

function TypeBadge({ type }: { type: string }) {
  const meta = getEntityTypeMeta(type);
  const variant = TYPE_BADGE_VARIANT[type] ?? 'neutral';
  return (
    <Badge variant={variant} className="font-mono text-[11px]">
      <span aria-hidden className="mr-[6px]">
        {meta?.glyph ?? '·'}
      </span>
      {meta?.label ?? type}
    </Badge>
  );
}

function SortHeader({
  label,
  active,
  dir,
  onClick,
  align = 'left',
}: {
  label: string;
  active: boolean;
  dir: SortDir;
  onClick: () => void;
  align?: 'left' | 'center' | 'right';
}) {
  const alignClass =
    align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start';
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'text-text-dim hover:text-text focus-visible:ring-accent-dim inline-flex w-full items-center gap-1 font-mono text-[10px] font-medium tracking-[1.4px] uppercase outline-none focus-visible:ring-[3px] ' +
        alignClass
      }
    >
      {label}
      <span aria-hidden className="text-text-dim w-[10px] text-[10px]">
        {active ? (dir === 'asc' ? '↑' : '↓') : ''}
      </span>
    </button>
  );
}

export default function CatalogPage() {
  const router = useRouter();
  const { data, isLoading, error } = useCatalogEntities();

  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<FilterPanelValue>({});
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const rows = useMemo<CatalogRow[]>(() => (data?.nodes ?? []).map(toRow), [data]);

  const facets = useMemo(
    () => [
      {
        id: 'types',
        label: 'Type',
        options: uniqueSorted(rows.map((r) => r.type)).map((v) => {
          const meta = getEntityTypeMeta(v);
          return { value: v, label: meta?.label ?? v };
        }),
      },
      {
        id: 'environments',
        label: 'Environment',
        options: uniqueSorted(rows.map((r) => r.environment)).map((v) => ({ value: v, label: v })),
      },
      {
        id: 'tiers',
        label: 'Tier',
        options: uniqueSorted(rows.map((r) => r.tier)).map((v) => ({ value: v, label: `T${v}` })),
      },
      {
        id: 'owners',
        label: 'Owner',
        options: uniqueSorted(rows.map((r) => r.owner)).map((v) => ({ value: v, label: v })),
      },
    ],
    [rows],
  );

  const counts = useMemo(() => {
    const c: Record<string, Record<string, number>> = {
      types: {},
      environments: {},
      tiers: {},
      owners: {},
    };
    for (const r of rows) {
      if (r.type) c.types[r.type] = (c.types[r.type] ?? 0) + 1;
      if (r.environment) c.environments[r.environment] = (c.environments[r.environment] ?? 0) + 1;
      if (r.tier) c.tiers[r.tier] = (c.tiers[r.tier] ?? 0) + 1;
      if (r.owner) c.owners[r.owner] = (c.owners[r.owner] ?? 0) + 1;
    }
    return c;
  }, [rows]);

  const visibleRows = useMemo(() => {
    const filtered = rows.filter((r) => matches(r, query, filter));
    return [...filtered].sort((a, b) => compareRows(a, b, sortKey, sortDir));
  }, [rows, query, filter, sortKey, sortDir]);

  const totalCount = rows.length;
  const visibleCount = visibleRows.length;
  const filtersActive = Object.values(filter).some((v) => v && v.length > 0) || query.length > 0;

  return (
    <div className="flex h-full">
      <aside className="border-border bg-panel w-72 shrink-0 overflow-y-auto border-r">
        <div className="border-border flex items-center gap-2 border-b px-4 py-3">
          <IconGlyph name="schema" size={14} />
          <span className="text-text text-[13px] font-medium">Filters</span>
        </div>
        <div className="p-4">
          <FilterPanel
            facets={facets}
            value={filter}
            counts={counts}
            onValueChange={setFilter}
            onReset={() => setFilter({})}
            title="Refine"
            className="w-full"
          />
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-border flex flex-col gap-1 border-b px-6 py-4">
          <div className="flex items-baseline gap-3">
            <h1 className="text-text text-[18px] font-semibold tracking-tight">Catalog</h1>
            <span className="text-text-dim font-mono text-[11px]">
              {filtersActive ? `${visibleCount} of ${totalCount}` : `${totalCount} entities`}
            </span>
          </div>
          <p className="text-text-muted text-[12px]">
            Every entity ingested by ShipIt — services, repositories, deployments, pipelines,
            monitors, teams, and people. Click an entity to inspect it.
          </p>
        </header>

        <div className="border-border flex items-center gap-3 border-b px-6 py-3">
          <div className="max-w-md flex-1">
            <Input
              icon={<IconGlyph name="search" />}
              placeholder="Search name, id, owner…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>

        <div className="flex-1 overflow-auto px-6 py-4">
          {isLoading ? (
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          ) : error ? (
            <EmptyState
              tone="err"
              icon={<IconGlyph name="warn" size={22} />}
              title="Couldn't load the catalog"
              description="The graph API didn't respond. Make sure the API is running and try again."
            />
          ) : totalCount === 0 ? (
            <EmptyState
              icon={<IconGlyph name="document" size={22} />}
              title="No entities yet"
              description="Connect a source and run a sync to populate the catalog."
            />
          ) : visibleCount === 0 ? (
            <EmptyState
              icon={<IconGlyph name="search" size={22} />}
              title="No entities match the current filters"
              description="Try clearing the search or resetting one of the facets."
            />
          ) : (
            <table className="w-full border-separate border-spacing-0 text-left text-[13px]">
              <thead className="bg-panel sticky top-0 z-10">
                <tr>
                  <th className="border-border border-b px-3 py-2">
                    <SortHeader
                      label="Name"
                      active={sortKey === 'name'}
                      dir={sortDir}
                      onClick={() => toggleSort('name')}
                    />
                  </th>
                  <th className="border-border w-[180px] border-b px-3 py-2">
                    <SortHeader
                      label="Type"
                      active={sortKey === 'type'}
                      dir={sortDir}
                      onClick={() => toggleSort('type')}
                    />
                  </th>
                  <th className="border-border w-[120px] border-b px-3 py-2">
                    <SortHeader
                      label="Env"
                      active={sortKey === 'environment'}
                      dir={sortDir}
                      onClick={() => toggleSort('environment')}
                    />
                  </th>
                  <th className="border-border w-[80px] border-b px-3 py-2">
                    <SortHeader
                      label="Tier"
                      active={sortKey === 'tier'}
                      dir={sortDir}
                      onClick={() => toggleSort('tier')}
                      align="center"
                    />
                  </th>
                  <th className="border-border w-[200px] border-b px-3 py-2">
                    <SortHeader
                      label="Owner"
                      active={sortKey === 'owner'}
                      dir={sortDir}
                      onClick={() => toggleSort('owner')}
                    />
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((r) => (
                  <tr
                    key={r.id}
                    onClick={() => router.push(`/catalog/${encodeURIComponent(r.id)}`)}
                    className="border-border hover:bg-panel-2 focus-within:bg-panel-2 cursor-pointer border-b transition-colors duration-(--duration-micro)"
                  >
                    <td className="px-3 py-[10px]">
                      <div className="flex min-w-0 flex-col">
                        <span className="text-text truncate font-medium">{r.name}</span>
                        <span className="text-text-dim truncate font-mono text-[10px]">{r.id}</span>
                      </div>
                    </td>
                    <td className="px-3 py-[10px]">
                      <TypeBadge type={r.type} />
                    </td>
                    <td className="px-3 py-[10px]">
                      {r.environment ? (
                        <span className="text-text-muted font-mono text-[11px]">
                          {r.environment}
                        </span>
                      ) : (
                        <span className="text-text-dim">—</span>
                      )}
                    </td>
                    <td className="px-3 py-[10px] text-center">
                      {r.tier ? (
                        <span className="text-text-muted font-mono text-[11px]">T{r.tier}</span>
                      ) : (
                        <span className="text-text-dim">—</span>
                      )}
                    </td>
                    <td className="px-3 py-[10px]">
                      {r.owner ? (
                        <span className="text-text-muted">{r.owner}</span>
                      ) : (
                        <span className="text-text-dim">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
