'use client';

import { useEffect, useMemo, useRef } from 'react';
import cytoscape, { type ElementDefinition } from 'cytoscape';
import {
  GraphCanvas as DSGraphCanvas,
  readThemeTokens,
  resolveColorReference,
  type GraphCanvasHandle,
  type ShipItStylesheetBlock,
} from '@ship-it-ui/cytoscape';
import { iconData } from '@ship-it-ui/icons';
import { listEntityTypes } from '@ship-it-ui/shipit';
import { useTheme } from '@ship-it-ui/ui';
import type { GraphData } from '@/lib/api';
import { useGraphStore } from '@/stores/graph-store';

// `iconToSvgDataUrl` from @ship-it-ui/icons@0.0.6 writes the requested color
// into the SVG's `fill` attribute, which only colors fills. Most icons in the
// manifest are Lucide strokes (`fill="none" stroke="currentColor"`) whose
// `currentColor` resolves against `color`, not `fill` — so they render black
// regardless of what colour cytoscape passes in. Build the data URL ourselves
// with `color` set so both strokes and fills inherit the entity-type tint.
function entityIconDataUrl(name: string, color: string, size = 52): string {
  const data = iconData[name];
  const safe = (s: string) => s.replace(/['"<>&]/g, (c) => XML_ESCAPES[c] ?? c);
  if (data) {
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' ` +
      `viewBox='${data.viewBox}' fill='${safe(color)}' color='${safe(color)}'>` +
      data.body +
      `</svg>`;
    return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
  }
  const text = name.replace(/[<>&"']/g, (c) => XML_ESCAPES[c] ?? c);
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}' ` +
    `viewBox='0 0 ${size} ${size}' fill='${safe(color)}' color='${safe(color)}'>` +
    `<text x='${size / 2}' y='${size * 0.65}' text-anchor='middle' ` +
    `font-family='ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace' ` +
    `font-size='${Math.round(size * 0.5)}'>${text}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

const XML_ESCAPES: Record<string, string> = {
  '<': '&lt;',
  '>': '&gt;',
  '&': '&amp;',
  '"': '&quot;',
  "'": '&apos;',
};

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

  // Per-entity-type icon overrides — see the comment on entityIconDataUrl for
  // the upstream colour bug we're working around. One selector per registered
  // type; only emitted when we have a palette to resolve `colorVar` against.
  const iconOverrides = useMemo<ShipItStylesheetBlock[]>(() => {
    if (!palette) return [];
    return listEntityTypes().map(([type, meta]) => {
      const color = resolveColorReference(meta.colorVar, palette);
      const escapedType = type.replace(/(["\\])/g, '\\$1');
      return {
        selector: `node[entityType = "${escapedType}"]`,
        style: {
          'background-image': entityIconDataUrl(meta.iconName, color),
          // Upstream sets background-fit: contain, which scales the icon to
          // fill the whole node and ignores explicit width/height. Switch to
          // `none` and pin the painted size so the icon has breathing room
          // away from the border.
          'background-fit': 'none',
          'background-width': '50%',
          'background-height': '50%',
          'background-position-x': '50%',
          'background-position-y': '50%',
        },
      };
    });
  }, [palette]);

  const elements = useMemo<ElementDefinition[]>(() => {
    const nodeIds = new Set(data.nodes.map((n) => n.data.id));
    // Cytoscape throws if an edge references a missing endpoint. Filter
    // defensively so a stale or truncated response from the API can't crash
    // the explorer; the API is supposed to keep these in sync but a single
    // dangling edge takes the whole canvas down.
    const safeEdges = data.edges.filter(
      (e) => nodeIds.has(e.data.source) && nodeIds.has(e.data.target),
    );
    // Each element needs a deterministic `id` for Cytoscape's internal
    // `cy.json()` reconciliation to identify it across re-renders. The API
    // returns edges without one — without this synthesis Cytoscape generates
    // a fresh random id on every render, fails to reconcile on the next pass,
    // and intermittently spams "cannot handle elements without an ID
    // attribute" while silently dropping edges from the canvas.
    const edgeIdSeen = new Map<string, number>();
    return [
      ...data.nodes.map((n) => ({
        data: { ...n.data, entityType: n.data.type, label: n.data.name },
        group: 'nodes' as const,
      })),
      ...safeEdges.map((e) => {
        const base = `${e.data.source}::${e.data.type}::${e.data.target}`;
        const dupIndex = edgeIdSeen.get(base) ?? 0;
        edgeIdSeen.set(base, dupIndex + 1);
        const id = dupIndex === 0 ? base : `${base}#${dupIndex}`;
        return { data: { ...e.data, id }, group: 'edges' as const };
      }),
    ];
  }, [data]);

  const layoutConfig = useMemo(() => {
    switch (layout) {
      case 'dagre':
        return { name: 'breadthfirst', directed: true, spacingFactor: 1.5, padding: 50 };
      case 'cose':
        // Spread nodes out: longer ideal edges + stronger node repulsion + a
        // higher overlap penalty so the layout doesn't settle with nodes
        // overlapping or hugging each other. `componentSpacing` also matters
        // when the graph has disconnected subgraphs.
        return {
          name: 'cose',
          idealEdgeLength: 160,
          nodeRepulsion: 8000,
          nodeOverlap: 40,
          componentSpacing: 200,
          numIter: 2000,
          padding: 50,
          animate: false,
        };
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
            ...iconOverrides,
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
