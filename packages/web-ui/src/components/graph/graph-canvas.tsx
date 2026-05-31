'use client';

import { useEffect, useMemo, useRef } from 'react';
import cytoscape, { type ElementDefinition } from 'cytoscape';
import { useQuery } from '@tanstack/react-query';
import {
  DEFAULT_OWNERSHIP_REL_TYPES,
  getOwnershipRelTypes,
  type ShipItSchema as SharedShipItSchema,
} from '@shipit-ai/shared/schema';
import {
  GraphCanvas as DSGraphCanvas,
  readThemeTokens,
  type GraphCanvasHandle,
} from '@ship-it-ui/cytoscape';
import { useTheme } from '@ship-it-ui/ui';
import { fetchSchema, type GraphData, type SchemaWithHash } from '@/lib/api';
import { useGraphStore } from '@/stores/graph-store';
import { buildOwnershipIndex } from './ownership-index';

interface GraphCanvasProps {
  data: GraphData;
  onNodeClick?: (nodeId: string) => void;
}

export function GraphCanvas({ data, onNodeClick }: GraphCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<GraphCanvasHandle | null>(null);
  const { layout, filters, setCyInstance } = useGraphStore();
  const { theme } = useTheme();

  // Schema drives which edge types count as ownership. Reuses the existing
  // ['schema'] query key from app/configure/schema/page.tsx — react-query
  // dedupes the fetch and shares the cache, so this is "free" once the schema
  // page or any other consumer has loaded it. Falls back to the well-known
  // default set during initial load and when the API is unreachable, so the
  // Owner filter never wedges waiting for a fetch.
  const { data: schemaResult } = useQuery<SchemaWithHash>({
    queryKey: ['schema'],
    queryFn: fetchSchema,
    staleTime: 5 * 60 * 1000,
  });

  const ownershipRelTypes = useMemo<ReadonlySet<string>>(() => {
    if (!schemaResult?.schema) return DEFAULT_OWNERSHIP_REL_TYPES;
    return getOwnershipRelTypes(schemaResult.schema as SharedShipItSchema);
  }, [schemaResult]);

  // The DS base edge style doesn't set `color`, so without this our edge
  // labels render in cytoscape's default black and disappear on the dark
  // panel. Re-resolve on theme flip so the tone tracks dark/light.
  const palette = useMemo(() => {
    void theme;
    return typeof document === 'undefined' ? null : readThemeTokens();
  }, [theme]);

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

  // Built from the raw graph payload — independent of Cytoscape — so changes
  // to filter selections don't re-walk every edge in the canvas. See
  // `buildOwnershipIndex` for the rules (CODEOWNER_OF/OWNS/etc. edges +
  // `d.owner` seed string + Team/Person self-membership).
  const ownershipIndex = useMemo(
    () => buildOwnershipIndex(data, ownershipRelTypes),
    [data, ownershipRelTypes],
  );

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
      if (filters.owners.length > 0) {
        const owners = ownershipIndex.get(node.id());
        const matches = owners && filters.owners.some((o) => owners.has(o));
        if (!matches) visible = false;
      }

      if (visible) node.removeClass('hidden');
      else node.addClass('hidden');
    });

    cy.edges().forEach((edge) => {
      const source = edge.source();
      const target = edge.target();
      if (source.hasClass('hidden') || target.hasClass('hidden')) edge.addClass('hidden');
      else edge.removeClass('hidden');
    });
  }, [filters, elements, ownershipIndex]);

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
