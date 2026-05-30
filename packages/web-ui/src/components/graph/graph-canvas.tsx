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

    // Build a per-node ownership index once so we can answer "does this node
    // pass the owner filter" without re-walking edges per node. A node is
    // considered "owned" by an owner if any of:
    //   - it has an incoming CODEOWNER_OF / OWNS / MEMBER_OF edge from a node
    //     whose `name` matches the owner (the GitHub-connected reality)
    //   - it carries a `d.owner` string equal to the owner (seeded data)
    //   - it *is* the Team/Person node whose name is the owner (so picking
    //     "platform-team" still shows the platform-team node itself)
    const OWNERSHIP_EDGE_TYPES = new Set(['CODEOWNER_OF', 'OWNS', 'MEMBER_OF']);
    const ownersByNodeId = new Map<string, Set<string>>();
    const recordOwner = (nodeId: string, owner: string) => {
      let set = ownersByNodeId.get(nodeId);
      if (!set) {
        set = new Set();
        ownersByNodeId.set(nodeId, set);
      }
      set.add(owner);
    };
    cy.nodes().forEach((node) => {
      const d = node.data();
      if (typeof d.owner === 'string' && d.owner) recordOwner(node.id(), d.owner);
      if ((d.type === 'Team' || d.type === 'Person') && typeof d.name === 'string' && d.name) {
        recordOwner(node.id(), d.name);
      }
    });
    cy.edges().forEach((edge) => {
      const type = edge.data('type');
      if (typeof type !== 'string' || !OWNERSHIP_EDGE_TYPES.has(type)) return;
      const sourceName = edge.source().data('name');
      const targetId = edge.target().id();
      if (typeof sourceName === 'string' && sourceName) recordOwner(targetId, sourceName);
    });

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
        const owners = ownersByNodeId.get(node.id());
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
