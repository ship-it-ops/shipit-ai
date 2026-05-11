'use client';

import { Button } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import {
  GraphInspector,
  type EntityType,
  type InspectorProperty,
  type InspectorRelation,
} from '@ship-it-ui/shipit';
import type { GraphData } from '@/lib/api';

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

export function NodeDetailPanel({ nodeId, graphData, onClose }: NodeDetailPanelProps) {
  const node = graphData.nodes.find((n) => n.data.id === nodeId);
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

  return (
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
        >
          View details
        </Button>
        <Button fullWidth variant="outline" size="sm" icon={<IconGlyph name="search" size={11} />}>
          Inspect claims
        </Button>
        <Button fullWidth variant="outline" size="sm" icon={<IconGlyph name="target" size={11} />}>
          Show blast radius
        </Button>
      </div>
    </div>
  );
}
