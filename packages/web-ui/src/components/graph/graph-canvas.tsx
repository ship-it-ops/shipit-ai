'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import cytoscape, { type ElementDefinition } from 'cytoscape';
import {
  GraphCanvas as DSGraphCanvas,
  readThemeTokens,
  type GraphCanvasHandle,
  type ThemeTokenPalette,
} from '@ship-it-ui/cytoscape';
import { useTheme } from '@ship-it-ui/ui';
import type { GraphData } from '@/lib/api';
import { useGraphStore } from '@/stores/graph-store';

interface GraphCanvasProps {
  data: GraphData;
  onNodeClick?: (nodeId: string) => void;
}

// Cytoscape's color parser doesn't accept `oklch()`, which is what our design
// tokens compute to. Paint each token into a 1×1 canvas and read the pixel
// back — the rasterizer always emits sRGB. Reading `ctx.fillStyle` is *not*
// enough: modern Chromium returns the oklch literal unchanged.
let toRgbCanvas: HTMLCanvasElement | null = null;
function toRgb(value: string, fallback: string): string {
  if (typeof document === 'undefined') return value || fallback;
  if (!toRgbCanvas) {
    toRgbCanvas = document.createElement('canvas');
    toRgbCanvas.width = 1;
    toRgbCanvas.height = 1;
  }
  const ctx = toRgbCanvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return value || fallback;
  ctx.clearRect(0, 0, 1, 1);
  ctx.fillStyle = '#000';
  ctx.fillStyle = value || fallback;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

function resolveSrgbPalette(): ThemeTokenPalette {
  const raw = readThemeTokens();
  return {
    bg: toRgb(raw.bg, '#0a0a0a'),
    panel: toRgb(raw.panel, '#0f0f0f'),
    panel2: toRgb(raw.panel2, '#161616'),
    border: toRgb(raw.border, '#262626'),
    borderStrong: toRgb(raw.borderStrong, '#383838'),
    text: toRgb(raw.text, '#fafafa'),
    textMuted: toRgb(raw.textMuted, '#a3a3a3'),
    textDim: toRgb(raw.textDim, '#737373'),
    accent: toRgb(raw.accent, '#3b82f6'),
    ok: toRgb(raw.ok, '#10b981'),
    warn: toRgb(raw.warn, '#f59e0b'),
    err: toRgb(raw.err, '#ef4444'),
    purple: toRgb(raw.purple, '#a855f7'),
    pink: toRgb(raw.pink, '#ec4899'),
  };
}

export function GraphCanvas({ data, onNodeClick }: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<GraphCanvasHandle | null>(null);
  const { layout, filters, setCyInstance } = useGraphStore();
  const { theme } = useTheme();
  const [palette, setPalette] = useState<ThemeTokenPalette | null>(null);

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

  // Resolve token palette client-side once mounted; re-resolve on theme flip.
  useEffect(() => {
    setPalette(resolveSrgbPalette());
  }, [theme]);

  // Track whether we've successfully run the layout in a non-zero container.
  // Used so the ResizeObserver can perform a one-shot initial layout if the
  // canvas mounted at 0×0 and only got real dimensions after layout commit.
  const hasLaidOutRef = useRef(false);

  // Resize observer: keep cytoscape's canvas matched to the container, but
  // *don't* re-run the layout. Force-directed (cose) and breadthfirst layouts
  // use container dimensions for spacing and finish with fit:true, so calling
  // them on every resize compounds the zoom and shrinks nodes off-screen.
  // Initial-mount 0×0 case is handled by the one-shot fallback inside.
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
      // Container hasn't been sized yet; the ResizeObserver one-shot will
      // run the layout once it has real dimensions.
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

  // Don't render the DS canvas until the palette is resolved client-side;
  // otherwise its first stylesheet pass uses oklch() strings that cytoscape's
  // color parser rejects (72 warnings + missing colors).
  if (!palette) {
    return (
      <div
        ref={containerRef}
        className="bg-bg border-border h-full w-full overflow-hidden rounded-md border"
      />
    );
  }

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
          palette,
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
