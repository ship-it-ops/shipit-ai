'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  Spinner,
  formatRelative,
} from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import {
  GraphInspector,
  getEntityTypeMeta,
  type EntityType,
  type InspectorProperty,
  type InspectorRelation,
} from '@ship-it-ui/shipit';
import type { GraphData } from '@/lib/api';
import { useGraphData } from '@/lib/hooks/use-graph-data';

const APP_TYPE_TO_ENTITY: Record<string, EntityType> = {
  LogicalService: 'service',
  RuntimeService: 'service',
  Repository: 'document',
  Deployment: 'deployment',
  Pipeline: 'service',
  Monitor: 'incident',
  Team: 'person',
  Person: 'person',
};

interface NodeDetailPanelProps {
  nodeId: string;
  graphData: GraphData;
  onClose: () => void;
}

interface Claim {
  property_key: string;
  value: unknown;
  source: string;
  source_id: string;
  confidence: number;
  ingested_at: string;
  evidence: unknown;
}

// Core-Writer projects claims onto each node as a stringified JSON blob under
// `_claims`. Parse defensively — older nodes may not have it, and a single
// malformed entry shouldn't break the dialog.
function parseClaims(raw: unknown): Claim[] {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Claim[]) : [];
  } catch {
    return [];
  }
}

export function NodeDetailPanel({ nodeId, graphData, onClose }: NodeDetailPanelProps) {
  const router = useRouter();
  const [dialog, setDialog] = useState<'claims' | 'blast' | null>(null);

  const node = graphData.nodes.find((n) => n.data.id === nodeId);

  const claims = useMemo(
    () => (node ? parseClaims((node.data as Record<string, unknown>)._claims) : []),
    [node],
  );

  // Depth-3 neighborhood = "blast radius" — only fetch when the dialog opens.
  const blastQuery = useGraphData(dialog === 'blast' ? nodeId : undefined, 3);

  if (!node) return null;

  const { name, type, tier, owner, environment } = node.data as {
    name: string;
    type: string;
    tier?: number;
    owner?: string;
    environment?: string;
  };

  const entityType = APP_TYPE_TO_ENTITY[type] ?? 'service';
  const connectedEdges = graphData.edges.filter(
    (e) => e.data.source === nodeId || e.data.target === nodeId,
  );

  const properties: InspectorProperty[] = [
    { key: 'type', value: type },
    ...(tier !== undefined ? [{ key: 'tier', value: `T${tier}` }] : []),
    ...(environment ? [{ key: 'env', value: environment }] : []),
    ...(owner ? [{ key: 'owner', value: owner }] : []),
  ];

  const relations: InspectorRelation[] = connectedEdges.slice(0, 12).map((edge) => {
    const targetId = edge.data.source === nodeId ? edge.data.target : edge.data.source;
    const direction = edge.data.source === nodeId ? '→' : '←';
    const targetNode = graphData.nodes.find((n) => n.data.id === targetId);
    return {
      relation: `${direction} ${edge.data.type}`,
      entity: targetNode?.data.name ?? targetId,
    };
  });

  const handleJumpTo = (id: string) => {
    setDialog(null);
    router.push(`/catalog/${encodeURIComponent(id)}`);
  };

  return (
    <>
      <div className="border-border bg-panel flex w-[360px] shrink-0 flex-col gap-3 overflow-y-auto border-l p-4">
        <div className="flex items-center justify-between">
          <span className="text-text-dim font-mono text-[10px]">node · {nodeId.slice(0, 12)}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close detail panel"
            className="text-text-dim hover:text-text rounded-sm p-1 leading-none"
          >
            ×
          </button>
        </div>

        <GraphInspector
          type={entityType}
          title={name}
          entityId={nodeId}
          description={owner ? `Owned by ${owner}` : undefined}
          properties={properties}
          relations={relations}
          relationCount={connectedEdges.length}
          className="w-auto"
        />

        <div className="flex flex-col gap-2 pt-2">
          <Button
            fullWidth
            variant="outline"
            size="sm"
            icon={<IconGlyph name="external" size={11} />}
            onClick={() => router.push(`/catalog/${encodeURIComponent(nodeId)}`)}
          >
            View details
          </Button>
          <Button
            fullWidth
            variant="outline"
            size="sm"
            icon={<IconGlyph name="search" size={11} />}
            onClick={() => setDialog('claims')}
          >
            Inspect claims
            {claims.length > 0 && (
              <Badge variant="neutral" size="sm" className="ml-auto font-mono">
                {claims.length}
              </Badge>
            )}
          </Button>
          <Button
            fullWidth
            variant="outline"
            size="sm"
            icon={<IconGlyph name="target" size={11} />}
            onClick={() => setDialog('blast')}
          >
            Show blast radius
          </Button>
        </div>
      </div>

      <ClaimsDialog
        open={dialog === 'claims'}
        onOpenChange={(o) => setDialog(o ? 'claims' : null)}
        nodeName={name}
        nodeId={nodeId}
        claims={claims}
      />

      <BlastRadiusDialog
        open={dialog === 'blast'}
        onOpenChange={(o) => setDialog(o ? 'blast' : null)}
        nodeId={nodeId}
        nodeName={name}
        data={blastQuery.data}
        isLoading={blastQuery.isLoading}
        error={blastQuery.error}
        onJumpTo={handleJumpTo}
      />
    </>
  );
}

// ──────────────────────────── ClaimsDialog ────────────────────────────

interface ClaimsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodeName: string;
  nodeId: string;
  claims: Claim[];
}

function ClaimsDialog({ open, onOpenChange, nodeName, nodeId, claims }: ClaimsDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width={680}
      title={`Claims · ${nodeName}`}
      description="Source-level facts that built this node's properties. Higher confidence wins on conflict."
    >
      {claims.length === 0 ? (
        <EmptyState
          icon={<IconGlyph name="search" size={20} />}
          title="No claims recorded"
          description={`The graph store has no source-level claims attached to ${nodeId}. Reseed or trigger a connector sync to populate.`}
        />
      ) : (
        <div className="border-border bg-panel-2 max-h-[420px] overflow-y-auto rounded-md border">
          <table className="w-full text-left text-[12px]">
            <thead className="bg-panel sticky top-0 z-10">
              <tr className="border-border text-text-dim border-b font-mono text-[10px] tracking-[1.4px] uppercase">
                <th className="px-3 py-2 font-medium">Property</th>
                <th className="px-3 py-2 font-medium">Value</th>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 text-right font-medium">Conf.</th>
                <th className="px-3 py-2 text-right font-medium">Ingested</th>
              </tr>
            </thead>
            <tbody>
              {claims.map((claim, i) => (
                <tr
                  key={`${claim.property_key}-${claim.source_id}-${i}`}
                  className="border-border border-b last:border-b-0"
                >
                  <td className="text-text px-3 py-2 font-mono">{claim.property_key}</td>
                  <td className="text-text break-all px-3 py-2">{String(claim.value)}</td>
                  <td className="text-text-muted px-3 py-2 font-mono text-[11px]">
                    {claim.source}
                  </td>
                  <td className="text-text-muted px-3 py-2 text-right font-mono tabular-nums">
                    {(claim.confidence * 100).toFixed(0)}%
                  </td>
                  <td className="text-text-dim px-3 py-2 text-right font-mono text-[11px]">
                    {claim.ingested_at ? formatRelative(claim.ingested_at) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Dialog>
  );
}

// ──────────────────────────── BlastRadiusDialog ────────────────────────────

interface BlastRadiusDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodeId: string;
  nodeName: string;
  data: GraphData | undefined;
  isLoading: boolean;
  error: unknown;
  onJumpTo: (id: string) => void;
}

function BlastRadiusDialog({
  open,
  onOpenChange,
  nodeId,
  nodeName,
  data,
  isLoading,
  error,
  onJumpTo,
}: BlastRadiusDialogProps) {
  // Exclude the starting node from the list — it's redundant context.
  const affected = useMemo(() => {
    if (!data) return [];
    return data.nodes
      .filter((n) => n.data.id !== nodeId)
      .map((n) => {
        const d = n.data as { id: string; name: string; type: string };
        return { id: d.id, name: d.name, type: d.type };
      });
  }, [data, nodeId]);

  const byType = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of affected) map.set(n.type, (map.get(n.type) ?? 0) + 1);
    return Array.from(map.entries()).sort((a, b) => b[1] - a[1]);
  }, [affected]);

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      width={560}
      title={`Blast radius · ${nodeName}`}
      description="Entities reachable within 3 hops. Clicking jumps to the catalog detail page."
    >
      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner />
        </div>
      ) : error ? (
        <EmptyState
          tone="err"
          icon={<IconGlyph name="warn" size={20} />}
          title="Couldn't compute blast radius"
          description="The neighborhood query failed. Check that the API server and Neo4j are reachable."
        />
      ) : affected.length === 0 ? (
        <EmptyState
          icon={<IconGlyph name="target" size={20} />}
          title="No reachable entities"
          description={`${nodeName} has no connections within 3 hops in the current graph.`}
        />
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-text-dim font-mono text-[10px] tracking-[1.4px] uppercase">
              {affected.length} affected
            </span>
            {byType.map(([type, count]) => {
              const meta = getEntityTypeMeta(type);
              return (
                <Badge key={type} variant="neutral" size="sm" className="font-mono">
                  <span aria-hidden className={`mr-1 ${meta.toneClass}`}>
                    {meta.glyph}
                  </span>
                  {meta.label} · {count}
                </Badge>
              );
            })}
          </div>
          <ul className="border-border bg-panel-2 max-h-[360px] flex-col overflow-y-auto rounded-md border">
            {affected.map((n) => {
              const meta = getEntityTypeMeta(n.type);
              return (
                <li key={n.id} className="border-border border-b last:border-b-0">
                  <button
                    type="button"
                    onClick={() => onJumpTo(n.id)}
                    className="hover:bg-panel focus-visible:ring-accent-dim flex w-full items-center gap-3 px-3 py-2 text-left text-[12px] outline-none focus-visible:ring-[3px]"
                  >
                    <span
                      aria-hidden
                      className={`grid h-6 w-6 place-items-center rounded-xs text-[13px] ${meta.toneBg} ${meta.toneClass}`}
                    >
                      {meta.glyph}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-text truncate">{n.name}</span>
                      <span className="text-text-dim truncate font-mono text-[10px]">
                        {meta.label}
                      </span>
                    </span>
                    <IconGlyph name="caretRight" size={12} />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Dialog>
  );
}
