'use client';

import { useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  Badge,
  type BadgeProps,
  Button,
  Card,
  EmptyState,
  formatRelative,
  Spinner,
} from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { getEntityTypeMeta } from '@ship-it-ui/shipit';
import { useGraphData } from '@/lib/hooks/use-graph-data';

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

function paramId(raw: string | string[] | undefined): string | null {
  if (!raw) return null;
  const segment = Array.isArray(raw) ? raw[0] : raw;
  if (!segment) return null;
  // `useParams()` in the App Router returns the raw URL segment — not the
  // decoded value. Our canonical ids contain `://` and `/`, which get
  // percent-encoded when pushed onto the URL; without an explicit decode
  // here, every downstream id comparison would silently fail.
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export default function EntityDetailPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const id = paramId(params?.id);

  const { data, isLoading, error } = useGraphData(id ?? undefined, 1);

  const node = useMemo(
    () => (id ? data?.nodes.find((n) => n.data.id === id) : undefined),
    [data, id],
  );

  const incoming = useMemo(() => {
    if (!id || !data) return [];
    return data.edges.filter((e) => e.data.target === id);
  }, [data, id]);
  const outgoing = useMemo(() => {
    if (!id || !data) return [];
    return data.edges.filter((e) => e.data.source === id);
  }, [data, id]);

  if (!id) {
    return (
      <div className="p-6">
        <EmptyState
          tone="err"
          icon={<IconGlyph name="warn" size={22} />}
          title="Missing entity id"
          description="The URL didn't include a catalog id."
        />
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  if (error || !node) {
    return (
      <div className="p-6">
        <EmptyState
          tone="warn"
          icon={<IconGlyph name="warn" size={22} />}
          title="Entity not found"
          description={`No ingested entity matches "${id}". It may have been removed since the catalog was last synced.`}
          action={
            <Button variant="outline" size="sm" onClick={() => router.push('/catalog')}>
              Back to catalog
            </Button>
          }
        />
      </div>
    );
  }

  const d = node.data as {
    id: string;
    name?: string;
    type?: string;
    owner?: string;
    environment?: string;
    tier?: number | string;
    [key: string]: unknown;
  };

  const type = d.type ?? 'Unknown';
  const name = d.name ?? d.id;
  const meta = getEntityTypeMeta(type);
  const variant = TYPE_BADGE_VARIANT[type] ?? 'neutral';

  const properties: Array<{ key: string; value: string }> = [];
  if (d.type) properties.push({ key: 'type', value: d.type });
  if (d.environment) properties.push({ key: 'environment', value: String(d.environment) });
  if (d.tier !== undefined) properties.push({ key: 'tier', value: `T${d.tier}` });
  if (d.owner) properties.push({ key: 'owner', value: String(d.owner) });

  // Surface every other primitive field on the node so different entity types
  // (Deployment vs Monitor vs Pipeline) each show their own metadata without
  // having to teach this page about each one. Underscore-prefixed keys are
  // Neo4j/Core-Writer system metadata (`_claims`, `_source_system`,
  // `_last_synced`, `_event_version`) — claims are already projected onto the
  // node as regular properties, so the raw JSON is noise here. Provenance
  // (source + last sync) is surfaced separately in the Summary card.
  const RESERVED = new Set(['id', 'label', 'name', 'type', 'environment', 'tier', 'owner']);
  for (const [k, v] of Object.entries(d)) {
    if (RESERVED.has(k)) continue;
    if (k.startsWith('_')) continue;
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      properties.push({ key: k, value: String(v) });
    }
  }

  const sourceSystem = typeof d['_source_system'] === 'string' ? d['_source_system'] : undefined;
  const lastSynced = typeof d['_last_synced'] === 'string' ? d['_last_synced'] : undefined;

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <header className="border-border flex flex-col gap-3 border-b px-6 py-5">
        <button
          type="button"
          onClick={() => router.push('/catalog')}
          className="text-text-muted hover:text-text inline-flex w-fit items-center gap-1 text-[12px]"
        >
          <IconGlyph name="prev" size={11} />
          Catalog
        </button>

        <div className="flex items-start gap-4">
          <span
            aria-hidden
            className={
              'rounded-base grid h-12 w-12 shrink-0 place-items-center text-[24px] leading-none ' +
              meta.toneBg +
              ' ' +
              meta.toneClass
            }
          >
            {meta.glyph}
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-text truncate text-[22px] font-semibold tracking-tight">
                {name}
              </h1>
              <Badge variant={variant} className="font-mono text-[11px]">
                {meta.label}
              </Badge>
            </div>
            <span className="text-text-dim truncate font-mono text-[11px]">{d.id}</span>
            {d.owner && (
              <span className="text-text-muted text-[12px]">Owned by {String(d.owner)}</span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              icon={<IconGlyph name="graph" size={12} />}
              onClick={() => router.push('/explore')}
            >
              Open in graph
            </Button>
          </div>
        </div>
      </header>

      <div className="grid flex-1 grid-cols-1 gap-6 px-6 py-6 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-6">
          <Card title="Properties">
            {properties.length === 0 ? (
              <p className="text-text-muted text-[12px]">No properties recorded.</p>
            ) : (
              <dl className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2 text-[13px]">
                {properties.map((p) => (
                  <PropertyRow key={p.key} k={p.key} value={p.value} />
                ))}
              </dl>
            )}
          </Card>

          <Card title={`Relations (${incoming.length + outgoing.length})`}>
            {incoming.length + outgoing.length === 0 ? (
              <p className="text-text-muted text-[12px]">No connected entities.</p>
            ) : (
              <div className="flex flex-col gap-5">
                {outgoing.length > 0 && (
                  <RelationGroup
                    direction="out"
                    edges={outgoing.map((e) => ({
                      otherId: e.data.target,
                      relation: e.data.type,
                    }))}
                    resolveName={(targetId) =>
                      data?.nodes.find((n) => n.data.id === targetId)?.data.name as
                        | string
                        | undefined
                    }
                    resolveType={(targetId) =>
                      data?.nodes.find((n) => n.data.id === targetId)?.data.type as
                        | string
                        | undefined
                    }
                    onOpen={(targetId) => router.push(`/catalog/${encodeURIComponent(targetId)}`)}
                  />
                )}
                {incoming.length > 0 && (
                  <RelationGroup
                    direction="in"
                    edges={incoming.map((e) => ({
                      otherId: e.data.source,
                      relation: e.data.type,
                    }))}
                    resolveName={(sourceId) =>
                      data?.nodes.find((n) => n.data.id === sourceId)?.data.name as
                        | string
                        | undefined
                    }
                    resolveType={(sourceId) =>
                      data?.nodes.find((n) => n.data.id === sourceId)?.data.type as
                        | string
                        | undefined
                    }
                    onOpen={(sourceId) => router.push(`/catalog/${encodeURIComponent(sourceId)}`)}
                  />
                )}
              </div>
            )}
          </Card>
        </div>

        <aside className="flex flex-col gap-6">
          <Card title="Summary">
            <dl className="grid grid-cols-[110px_1fr] gap-x-4 gap-y-2 text-[12px]">
              <dt className="text-text-dim font-mono uppercase">Type</dt>
              <dd className="text-text">{meta.label}</dd>
              <dt className="text-text-dim font-mono uppercase">Inbound</dt>
              <dd className="text-text font-mono">{incoming.length}</dd>
              <dt className="text-text-dim font-mono uppercase">Outbound</dt>
              <dd className="text-text font-mono">{outgoing.length}</dd>
              {sourceSystem && (
                <>
                  <dt className="text-text-dim font-mono uppercase">Source</dt>
                  <dd className="text-text">{sourceSystem}</dd>
                </>
              )}
              {lastSynced && (
                <>
                  <dt className="text-text-dim font-mono uppercase">Synced</dt>
                  <dd className="text-text" title={lastSynced}>
                    {formatRelative(lastSynced)}
                  </dd>
                </>
              )}
            </dl>
          </Card>

          <Card title="Actions">
            <div className="flex flex-col gap-2">
              <Button
                fullWidth
                variant="outline"
                size="sm"
                icon={<IconGlyph name="target" size={11} />}
              >
                Show blast radius
              </Button>
              <Button
                fullWidth
                variant="outline"
                size="sm"
                icon={<IconGlyph name="search" size={11} />}
              >
                Inspect claims
              </Button>
              <Button
                fullWidth
                variant="outline"
                size="sm"
                icon={<IconGlyph name="external" size={11} />}
              >
                View in source
              </Button>
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}

function PropertyRow({ k, value }: { k: string; value: string }) {
  return (
    <>
      <dt className="text-text-dim font-mono text-[11px] uppercase">{k}</dt>
      <dd className="text-text break-words">{value}</dd>
    </>
  );
}

function RelationGroup({
  direction,
  edges,
  resolveName,
  resolveType,
  onOpen,
}: {
  direction: 'in' | 'out';
  edges: Array<{ otherId: string; relation: string }>;
  resolveName: (id: string) => string | undefined;
  resolveType: (id: string) => string | undefined;
  onOpen: (id: string) => void;
}) {
  const heading = direction === 'out' ? 'Depends on' : 'Used by';
  const arrow = direction === 'out' ? '→' : '←';
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-text-dim font-mono text-[10px] tracking-[1.4px] uppercase">{heading}</h3>
      <ul className="flex flex-col gap-1">
        {edges.map((e, i) => {
          const targetName = resolveName(e.otherId) ?? e.otherId;
          const targetType = resolveType(e.otherId);
          const meta = targetType ? getEntityTypeMeta(targetType) : null;
          return (
            <li key={`${e.otherId}-${i}`}>
              <button
                type="button"
                onClick={() => onOpen(e.otherId)}
                className="hover:bg-panel-2 focus-visible:ring-accent-dim flex w-full items-center gap-3 rounded-sm px-2 py-2 text-left text-[12px] outline-none focus-visible:ring-[3px]"
              >
                <span aria-hidden className="text-text-dim w-3 font-mono text-[10px]">
                  {arrow}
                </span>
                <span
                  aria-hidden
                  className={
                    'grid h-6 w-6 place-items-center rounded-xs text-[13px] ' +
                    (meta ? meta.toneBg + ' ' + meta.toneClass : 'bg-panel-2 text-text-dim')
                  }
                >
                  {meta?.glyph ?? '·'}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-text truncate">{targetName}</span>
                  <span className="text-text-dim truncate font-mono text-[10px]">{e.relation}</span>
                </span>
                <IconGlyph name="caretRight" size={12} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
