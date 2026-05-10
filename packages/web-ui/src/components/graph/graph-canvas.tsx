'use client';

import { useEffect, useRef, useCallback } from 'react';
import cytoscape, { type Core, type ElementDefinition, type StylesheetStyle } from 'cytoscape';
import { useTheme } from '@ship-it-ui/ui';
import type { GraphData } from '@/lib/api';
import { useGraphStore } from '@/stores/graph-store';

type AppNodeType =
  | 'LogicalService'
  | 'RuntimeService'
  | 'Repository'
  | 'Deployment'
  | 'Pipeline'
  | 'Monitor'
  | 'Team'
  | 'Person';

const NODE_COLOR_VAR: Record<AppNodeType, string> = {
  LogicalService: '--color-accent',
  RuntimeService: '--color-accent-text',
  Repository: '--color-ok',
  Deployment: '--color-warn',
  Pipeline: '--color-pink',
  Monitor: '--color-err',
  Team: '--color-purple',
  Person: '--color-text-muted',
};

const NODE_SHAPE: Record<AppNodeType, string> = {
  LogicalService: 'ellipse',
  RuntimeService: 'diamond',
  Repository: 'round-rectangle',
  Deployment: 'hexagon',
  Pipeline: 'round-rectangle',
  Monitor: 'triangle',
  Team: 'ellipse',
  Person: 'ellipse',
};

let resolveCanvas: HTMLCanvasElement | null = null;

function resolveColor(varName: string, fallback = '#888888'): string {
  if (typeof document === 'undefined') return fallback;
  const raw = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
  if (!raw) return fallback;
  if (!resolveCanvas) {
    resolveCanvas = document.createElement('canvas');
    resolveCanvas.width = 1;
    resolveCanvas.height = 1;
  }
  const ctx = resolveCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return raw;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = '#000';
  ctx.fillStyle = raw;
  ctx.fillRect(0, 0, 1, 1);
  const data = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${data[0]}, ${data[1]}, ${data[2]})`;
}

function buildStyle(): StylesheetStyle[] {
  const text = resolveColor('--color-text', '#222222');
  const textMuted = resolveColor('--color-text-muted', '#888888');
  const textDim = resolveColor('--color-text-dim', '#aaaaaa');
  const border = resolveColor('--color-border', '#dddddd');
  const borderStrong = resolveColor('--color-border-strong', '#bbbbbb');
  const accent = resolveColor('--color-accent', '#3b82f6');

  const baseNode: StylesheetStyle = {
    selector: 'node',
    style: {
      label: 'data(name)',
      'text-valign': 'bottom',
      'text-margin-y': 8,
      'font-size': '11px',
      color: text,
      'text-max-width': '120px',
      'text-wrap': 'ellipsis',
      width: 40,
      height: 40,
      'background-color': textMuted,
      'border-width': 2,
      'border-color': borderStrong,
    },
  };

  const typeStyles: StylesheetStyle[] = (Object.keys(NODE_COLOR_VAR) as AppNodeType[]).map((type) => ({
    selector: `node[type="${type}"]`,
    style: {
      'background-color': resolveColor(NODE_COLOR_VAR[type], textMuted),
      'border-color': resolveColor(NODE_COLOR_VAR[type], borderStrong),
      shape: NODE_SHAPE[type] as cytoscape.Css.NodeShape,
    },
  }));

  return [
    baseNode,
    ...typeStyles,
    {
      selector: 'node[type="Person"]',
      style: { width: 28, height: 28, 'font-size': '9px' },
    },
    {
      selector: 'edge',
      style: {
        width: 1.5,
        'line-color': border,
        'target-arrow-color': textDim,
        'target-arrow-shape': 'triangle',
        'curve-style': 'bezier',
        label: 'data(type)',
        'font-size': '8px',
        color: textMuted,
        'text-rotation': 'autorotate',
        'text-margin-y': -10,
      },
    },
    {
      selector: 'node:selected',
      style: {
        'border-width': 3,
        'border-color': accent,
        'overlay-opacity': 0.12,
        'overlay-color': accent,
      },
    },
    {
      selector: '.hidden',
      style: { display: 'none' },
    },
  ];
}

interface GraphCanvasProps {
  data: GraphData;
  onNodeClick?: (nodeId: string) => void;
}

export function GraphCanvas({ data, onNodeClick }: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const { layout, filters } = useGraphStore();
  const { theme } = useTheme();

  const getLayoutConfig = useCallback(() => {
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

  // Mount Cytoscape with current theme tokens.
  useEffect(() => {
    if (!containerRef.current) return;

    const elements: ElementDefinition[] = [
      ...data.nodes.map((n) => ({ data: n.data, group: 'nodes' as const })),
      ...data.edges.map((e) => ({ data: e.data, group: 'edges' as const })),
    ];

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: buildStyle(),
      layout: getLayoutConfig(),
      minZoom: 0.2,
      maxZoom: 3,
      wheelSensitivity: 0.3,
    });

    cy.on('tap', 'node', (evt) => {
      onNodeClick?.(evt.target.id());
    });

    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [data, getLayoutConfig, onNodeClick]);

  // Restyle on theme change.
  useEffect(() => {
    cyRef.current?.style(buildStyle());
  }, [theme]);

  // Apply filters.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.nodes().forEach((node) => {
      const d = node.data();
      let visible = true;
      if (filters.nodeLabels.length > 0 && !filters.nodeLabels.includes(d.type)) visible = false;
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
  }, [filters]);

  // Re-run layout when toggled.
  useEffect(() => {
    cyRef.current?.layout(getLayoutConfig()).run();
  }, [layout, getLayoutConfig]);

  return <div ref={containerRef} className="bg-bg border-border h-full w-full rounded-md border" />;
}
