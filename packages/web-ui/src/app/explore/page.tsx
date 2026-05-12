'use client';

import { useState, useCallback, useMemo } from 'react';
import { Button, Input } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import {
  GraphLegend,
  listEntityTypes,
  type EntityType,
  type GraphLegendEntry,
} from '@ship-it-ui/shipit';
import { GraphCanvas } from '@/components/graph/graph-canvas';
import { GraphControls } from '@/components/graph/graph-controls';
import { FilterPanel } from '@/components/graph/filter-panel';
import { NodeDetailPanel } from '@/components/graph/node-detail-panel';
import { useGraphStore } from '@/stores/graph-store';
import { useInitialGraphData } from '@/lib/hooks/use-graph-data';

export default function GraphExplorerPage() {
  const [filterOpen, setFilterOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const { selectedNode, setSelectedNode } = useGraphStore();

  const { data: graphData } = useInitialGraphData();

  const handleNodeClick = useCallback(
    (nodeId: string) => setSelectedNode(nodeId),
    [setSelectedNode],
  );

  // Legend entries from the registered entity types — stays in sync with
  // `src/lib/entity-types.ts` so new node types automatically appear.
  const legendEntries = useMemo<GraphLegendEntry[]>(
    () =>
      listEntityTypes().map(([type, meta]) => ({
        type: type as EntityType,
        label: meta.label,
      })),
    [],
  );

  return (
    <div className="flex h-full">
      <FilterPanel open={filterOpen} onClose={() => setFilterOpen(false)} />

      <div className="flex flex-1 flex-col">
        <div className="border-border flex items-center gap-3 border-b px-4 py-3">
          <Button
            variant={filterOpen ? 'secondary' : 'outline'}
            size="sm"
            icon={<IconGlyph name="schema" size={12} />}
            onClick={() => setFilterOpen(!filterOpen)}
          >
            Filters
          </Button>

          <div className="max-w-md flex-1">
            <Input
              icon={<IconGlyph name="search" />}
              placeholder="Search nodes…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>

          <div className="ml-auto">
            <GraphControls />
          </div>
        </div>

        <div className="relative flex-1 p-3">
          {graphData ? (
            <>
              <GraphCanvas data={graphData} onNodeClick={handleNodeClick} />
              <div className="absolute bottom-5 right-5 z-10">
                <GraphLegend
                  entries={legendEntries}
                  heading="Node types"
                  className="bg-panel/95 border-border max-w-[180px] border shadow-lg backdrop-blur"
                />
              </div>
            </>
          ) : (
            <div className="text-text-muted flex h-full items-center justify-center">
              <p className="text-[13px]">
                No graph data yet. Seed data with{' '}
                <code className="bg-panel-2 text-text rounded-xs px-[6px] py-[2px] font-mono text-[11px]">
                  pnpm seed
                </code>{' '}
                to get started.
              </p>
            </div>
          )}
        </div>
      </div>

      {selectedNode && graphData && (
        <NodeDetailPanel
          nodeId={selectedNode}
          graphData={graphData}
          onClose={() => setSelectedNode(null)}
        />
      )}
    </div>
  );
}
