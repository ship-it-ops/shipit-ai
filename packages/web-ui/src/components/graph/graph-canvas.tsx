'use client';

import { useEffect, useMemo, useRef } from 'react';
import cytoscape, { type ElementDefinition } from 'cytoscape';
import {
  GraphCanvas as DSGraphCanvas,
  type GraphCanvasHandle,
  type ShipItStylesheetBlock,
} from '@ship-it-ui/cytoscape';
import { listEntityTypes } from '@ship-it-ui/shipit';
import { useTheme } from '@ship-it-ui/ui';
import type { GraphData } from '@/lib/api';
import { useGraphStore } from '@/stores/graph-store';

// `@ship-it-ui/cytoscape@0.0.3`'s `glyphDataUrl` emits SVGs with only a
// `viewBox` — no `width`/`height` attributes — and cytoscape can't size those
// background-image SVGs on its canvas, so the glyph never paints. Restore the
// docs-page aesthetic by emitting our own per-type `background-image` rules
// with explicit dimensions. Override wins because we register the rules after
// the DS's via `styleOptions.extra`.
function glyphSvgDataUrl(glyph: string, color: string): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='52' height='52' viewBox='0 0 52 52'>` +
    `<text x='26' y='34' text-anchor='middle' ` +
    `font-family='ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace' ` +
    `font-size='26' fill='${color}'>${glyph}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function buildGlyphOverrides(): ShipItStylesheetBlock[] {
  if (typeof document === 'undefined') return [];
  // Resolve each registered type's tone to sRGB via the same trick the DS uses
  // in `readThemeTokens` — render to a hidden canvas pixel and read back.
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  function colorVarToRgb(cssVar: string): string {
    if (!ctx) return cssVar;
    // Pull the underlying `--color-…` value off the document root, then paint
    // it onto the 1×1 canvas to coerce oklch() → sRGB.
    const match = cssVar.match(/var\((--[^,)]+)/);
    const name = match?.[1] ?? '';
    const raw = name
      ? getComputedStyle(document.documentElement).getPropertyValue(name).trim()
      : cssVar;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = raw || cssVar;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `rgb(${r}, ${g}, ${b})`;
  }
  return listEntityTypes().map(([type, meta]) => ({
    selector: `node[entityType = "${type.replace(/[\\"]/g, (c) => `\\${c}`)}"]`,
    style: {
      'background-image': glyphSvgDataUrl(meta.glyph, colorVarToRgb(meta.colorVar)),
      'background-fit': 'contain',
      'background-clip': 'none',
    },
  })) as ShipItStylesheetBlock[];
}

interface GraphCanvasProps {
  data: GraphData;
  onNodeClick?: (nodeId: string) => void;
}

export function GraphCanvas({ data, onNodeClick }: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<GraphCanvasHandle | null>(null);
  const { layout, filters, setCyInstance } = useGraphStore();
  const { theme } = useTheme();

  // Re-derive on theme flip so glyph fill matches the active palette.
  const glyphOverrides = useMemo(() => {
    void theme;
    return buildGlyphOverrides();
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
            ...glyphOverrides,
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
