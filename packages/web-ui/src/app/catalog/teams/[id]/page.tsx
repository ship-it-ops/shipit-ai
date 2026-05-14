'use client';

import { useParams, useRouter } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Badge, Button, Card, EmptyState, Spinner } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { fetchTeam, type TeamDetail } from '@/lib/api';
import { TeamInventory } from '@/components/teams/team-inventory';

export default function TeamDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = decodeURIComponent(Array.isArray(params?.id) ? params.id[0] : (params?.id ?? ''));

  const { data, isLoading, error } = useQuery<TeamDetail>({
    queryKey: ['team', id],
    queryFn: () => fetchTeam(id),
    enabled: !!id,
  });

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (error || !data) {
    return (
      <div className="p-6">
        <EmptyState
          tone="err"
          icon={<IconGlyph name="warn" size={22} />}
          title="Failed to load team"
          description={(error as Error | null)?.message ?? 'Team not found.'}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full max-w-[1200px] flex-col gap-4 p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => router.push('/catalog/teams')}
            icon={<IconGlyph name="prev" size={12} />}
          >
            Teams
          </Button>
          <div className="mt-2 flex items-center gap-2">
            <h1 className="text-text text-[22px] font-semibold tracking-tight">{data.name}</h1>
            <Badge variant="purple">team</Badge>
          </div>
          <p className="text-text-dim mt-1 font-mono text-[11px]">{data.id}</p>
          {data.description && (
            <p className="text-text-muted mt-2 max-w-2xl text-[13px]">{data.description}</p>
          )}
          {data.email && (
            <a
              href={`mailto:${data.email}`}
              className="text-text-muted hover:text-accent mt-1 inline-flex items-center gap-1 text-[12px]"
            >
              <IconGlyph name="mention" size={11} /> {data.email}
            </a>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => router.push(`/explore?focus=${encodeURIComponent(data.id)}`)}
          icon={<IconGlyph name="graph" size={12} />}
        >
          View team graph
        </Button>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <TeamInventory title="Services" entities={data.services} glyph="service" />
        <TeamInventory title="Repositories" entities={data.repositories} glyph="github" />
        <TeamInventory title="Deployments" entities={data.deployments} glyph="bolt" />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title={`Members (${data.members.length})`}>
          {data.members.length === 0 ? (
            <p className="text-text-dim text-[12px]">No members on record.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {data.members.map((m) => (
                <li
                  key={m.id}
                  className="border-border bg-panel flex items-center justify-between rounded-xs border px-2 py-1.5 text-[12px]"
                >
                  <div className="flex items-center gap-2">
                    <IconGlyph name="person" size={12} />
                    <span className="text-text">{m.name}</span>
                    <span className="text-text-dim font-mono text-[10px]">@{m.login}</span>
                  </div>
                  {m.role && (
                    <Badge size="sm" variant="neutral">
                      {m.role}
                    </Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title={`On-call (${data.onCall.length})`}>
          {data.onCall.length === 0 ? (
            <p className="text-text-dim text-[12px]">No on-call assignments.</p>
          ) : (
            <ul className="m-0 flex list-none flex-col gap-1 p-0">
              {data.onCall.map((oc, i) => (
                <li
                  key={i}
                  className="border-border bg-panel flex items-center justify-between gap-2 rounded-xs border px-2 py-1.5 text-[12px]"
                >
                  <span className="text-text-muted truncate">{oc.serviceName}</span>
                  <span className="text-text-dim">→</span>
                  <span className="text-text font-medium">{oc.personName}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
