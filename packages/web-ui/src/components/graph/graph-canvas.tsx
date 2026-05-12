'use client';

import { useEffect, useMemo, useRef } from 'react';
import cytoscape, { type ElementDefinition } from 'cytoscape';
import { GraphCanvas as DSGraphCanvas, type GraphCanvasHandle } from '@ship-it-ui/cytoscape';
import type { GraphData } from '@/lib/api';
import { useGraphStore } from '@/stores/graph-store';

interface GraphCanvasProps {
  data: GraphData;
  onNodeClick?: (nodeId: string) => void;
}

export function GraphCanvas({ data, onNodeClick }: GraphCanvasProps) {
  const handleRef = useRef<GraphCanvasHandle | null>(null);
  const { layout, filters } = useGraphStore();

  const elements = useMemo<ElementDefinition[]>(
    () => [
      ...data.nodes.map((n) => ({
        data: { ...n.data, entityType: n.data.type, label: n.data.name },
        group: 'nodes' as const,
      })),
      ...data.edges.map((e) => ({ data: e.data, group: 'edges' as const })),
    ],
    [data],
  );

  const layoutConfig = useMemo(() => {
    switch (layout) {
      case 'dagre':
        return { name: 'breadthfirst', directed: true, spacingFactor: 1.5, padding: 50 };
      case 'cose':
        return { name: 'cose', idealEdgeLength: 100, nodeOverlap: 20, padding: 50, animate: false };
      case 'concentric':
        return { name: 'concentric', minNodeSpacing: 60, padding: 50 };
      default:
        return { name: 'breadthfirst', directed: true, spacingFactor: 1.5, padding: 50 };
    }
  }, [layout]);

  // The DS GraphCanvas updates elements without re-running layout. New nodes
  // would land at (0,0); re-run the configured layout after each elements swap.
  useEffect(() => {
    const cy = handleRef.current?.cy;
    if (!cy) return;
    cy.layout(layoutConfig).run();
  }, [elements, layoutConfig]);

  // Apply visibility filters by toggling Cytoscape classes on the live instance.
  useEffect(() => {
    const cy = handleRef.current?.cy;
    if (!cy) return;

    cy.nodes().forEach((node) => {
      const d = node.data();
      let visible = true;
      if (filters.nodeLabels.length > 0 && !filters.nodeLabels.includes(d.entityType ?? d.type))
        visible = false;
      if (
        filters.environments.length > 0 &&
        d.environment &&
        !filters.environments.includes(d.environment)
      )
        visible = false;
      if (filters.tiers.length > 0 && d.tier && !filters.tiers.includes(String(d.tier)))
        visible = false;
      if (filters.owners.length > 0 && d.owner && !filters.owners.includes(d.owner))
        visible = false;

      if (visible) node.removeClass('hidden');
      else node.addClass('hidden');
    });

    cy.edges().forEach((edge) => {
      const source = edge.source();
      const target = edge.target();
      if (source.hasClass('hidden') || target.hasClass('hidden')) edge.addClass('hidden');
      else edge.removeClass('hidden');
    });
  }, [filters, elements]);

  return (
    <div className="bg-bg border-border h-full w-full overflow-hidden rounded-md border">
      <DSGraphCanvas
        ref={handleRef}
        engine={cytoscape}
        elements={elements}
        layout={layoutConfig}
        onSelect={(node) => onNodeClick?.(node.id())}
        styleOptions={{
          extra: [
            { selector: '.hidden', style: { display: 'none' } },
            {
              selector: 'edge',
              style: {
                label: 'data(type)',
                'font-size': '8px',
                'text-rotation': 'autorotate',
                'text-margin-y': -10,
              },
            },
          ],
        }}
      />
    </div>
  );
}
