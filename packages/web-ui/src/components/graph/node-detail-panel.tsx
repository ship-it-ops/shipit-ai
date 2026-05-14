'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Dialog, EmptyState, formatRelative } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import {
  GraphInspector,
  type EntityType,
  type InspectorProperty,
  type InspectorRelation,
} from '@ship-it-ui/shipit';
import type { GraphData } from '@/lib/api';
import { useBlastRadius } from '@/lib/hooks/use-graph-data';
import { BlastRadiusDialog } from '@/components/blast-radius-dialog';

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

  // Blast radius — directed traversal of inbound impact edges. Only fetches
  // when the dialog opens, matching what the catalog detail page does. Sharing
  // the hook + dialog keeps results consistent across surfaces.
  const blastQuery = useBlastRadius(nodeId, 3, dialog === 'blast');

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
        startId={nodeId}
        startName={name}
        data={blastQuery.data}
        isLoading={blastQuery.isLoading}
        error={blastQuery.error}
        onOpenEntity={handleJumpTo}
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
                  <td className="text-text px-3 py-2 break-all">{String(claim.value)}</td>
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

