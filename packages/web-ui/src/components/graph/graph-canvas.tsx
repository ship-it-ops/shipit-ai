'use client';

import { useEffect, useMemo, useRef } from 'react';
import cytoscape, { type ElementDefinition } from 'cytoscape';
import {
  GraphCanvas as DSGraphCanvas,
  readThemeTokens,
  type GraphCanvasHandle,
} from '@ship-it-ui/cytoscape';
import { useTheme } from '@ship-it-ui/ui';
import type { GraphData } from '@/lib/api';
import { useGraphStore } from '@/stores/graph-store';

interface GraphCanvasProps {
  data: GraphData;
  onNodeClick?: (nodeId: string) => void;
}

export function GraphCanvas({ data, onNodeClick }: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<GraphCanvasHandle | null>(null);
  const { layout, filters, setCyInstance } = useGraphStore();
  const { theme } = useTheme();

  // The DS base edge style doesn't set `color`, so without this our edge
  // labels render in cytoscape's default black and disappear on the dark
  // panel. Re-resolve on theme flip so the tone tracks dark/light.
  const palette = useMemo(() => {
    void theme;
    return typeof document === 'undefined' ? null : readThemeTokens();
  }, [theme]);

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

  // Track whether we've successfully run the layout in a non-zero container.
  // Used so the ResizeObserver can perform a one-shot initial layout if the
  // canvas mounted at 0×0 and only got real dimensions after layout commit.
  const hasLaidOutRef = useRef(false);

  // Resize observer: keep cytoscape's canvas matched to the container, but
  // *don't* re-run the layout on every resize. Force-directed (cose) and
  // breadthfirst layouts use container dimensions for spacing and finish with
  // fit:true, so re-running compounds the zoom. The DS doesn't ship its own
  // resize handling; this stays a consumer concern.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      const cy = handleRef.current?.cy;
      if (!cy) return;
      cy.resize();
      if (!hasLaidOutRef.current && cy.nodes().length > 0) {
        const { width, height } = container.getBoundingClientRect();
        if (width > 0 && height > 0) {
          cy.layout(layoutConfig).run();
          hasLaidOutRef.current = true;
        }
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [layoutConfig]);

  // Run layout when elements or layout config changes. Also publish the live
  // cy instance to the store so GraphControls (zoom, fit, etc.) can drive it.
  useEffect(() => {
    const cy = handleRef.current?.cy;
    if (!cy) return;
    setCyInstance(cy);
    cy.resize();
    const { width, height } = containerRef.current?.getBoundingClientRect() ?? {
      width: 0,
      height: 0,
    };
    if (width > 0 && height > 0) {
      cy.layout(layoutConfig).run();
      hasLaidOutRef.current = true;
    } else {
      hasLaidOutRef.current = false;
    }
    return () => {
      setCyInstance(null);
    };
  }, [elements, layoutConfig, setCyInstance]);

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
    <div
      ref={containerRef}
      className="bg-bg border-border h-full w-full overflow-hidden rounded-md border"
    >
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
                ...(palette ? { color: palette.textMuted } : {}),
              },
            },
          ],
        }}
      />
    </div>
  );
}
