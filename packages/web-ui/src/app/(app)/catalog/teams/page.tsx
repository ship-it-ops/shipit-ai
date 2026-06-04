'use client';

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { EmptyState, Input, Spinner } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { fetchTeams, type TeamSummary } from '@/lib/api';
import { TeamSummaryCard } from '@/components/teams/team-summary-card';

export default function TeamsListPage() {
  const [search, setSearch] = useState('');
  const { data, isLoading, error } = useQuery<TeamSummary[]>({
    queryKey: ['teams'],
    queryFn: fetchTeams,
  });

  const filtered = useMemo(() => {
    if (!data) return [];
    const q = search.trim().toLowerCase();
    if (!q) return data;
    return data.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        t.slug.toLowerCase().includes(q) ||
        (t.description ?? '').toLowerCase().includes(q),
    );
  }, [data, search]);

  return (
    <div className="mx-auto flex h-full max-w-[1200px] flex-col gap-4 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-text text-[22px] font-semibold tracking-tight">Team Dashboard</h1>
          <p className="text-text-muted mt-1 text-[13px]">
            Every team in the graph with the services, repositories, and deployments they own.
          </p>
        </div>
      </header>

      <div className="max-w-sm">
        <Input
          icon={<IconGlyph name="search" />}
          placeholder="Search teams by name or slug…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner />
        </div>
      ) : error ? (
        <EmptyState
          tone="err"
          icon={<IconGlyph name="warn" size={22} />}
          title="Failed to load teams"
          description={(error as Error).message}
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<IconGlyph name="person" size={22} />}
          title={data && data.length === 0 ? 'No teams in the graph yet' : 'No teams match'}
          description={
            data && data.length === 0
              ? 'Configure a GitHub or Identity Provider connector, or run pnpm seed for demo data.'
              : 'Try a different search.'
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((team) => (
            <TeamSummaryCard key={team.id} team={team} />
          ))}
        </div>
      )}
    </div>
  );
}
