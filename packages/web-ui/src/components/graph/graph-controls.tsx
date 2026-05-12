'use client';

import {
  Button,
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  MenuItem,
} from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { useGraphStore } from '@/stores/graph-store';

const layouts = [
  { id: 'dagre' as const, label: 'Hierarchical (Dagre)' },
  { id: 'cose' as const, label: 'Force-Directed (CoSE)' },
  { id: 'concentric' as const, label: 'Concentric' },
];

const ZOOM_STEP = 1.25;

export function GraphControls() {
  const { layout, setLayout, cyInstance: cy } = useGraphStore();
  const current = layouts.find((l) => l.id === layout)?.label ?? 'Layout';

  const ready = cy !== null;

  const zoomBy = (factor: number) => {
    if (!cy) return;
    const container = cy.container();
    if (!container) return;
    const { width, height } = container.getBoundingClientRect();
    cy.animate(
      {
        zoom: {
          level: cy.zoom() * factor,
          renderedPosition: { x: width / 2, y: height / 2 },
        },
      },
      { duration: 140 },
    );
  };

  const handleFit = () => {
    if (!cy) return;
    cy.animate({ fit: { eles: cy.elements(), padding: 40 } }, { duration: 200 });
  };

  return (
    <div className="border-border bg-panel flex items-center gap-1 rounded-md border p-[3px]">
      <Button
        variant="ghost"
        size="sm"
        aria-label="Zoom in"
        disabled={!ready}
        onClick={() => zoomBy(ZOOM_STEP)}
      >
        <IconGlyph name="add" size={12} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Zoom out"
        disabled={!ready}
        onClick={() => zoomBy(1 / ZOOM_STEP)}
      >
        <IconGlyph name="remove" size={12} />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Fit to screen"
        disabled={!ready}
        onClick={handleFit}
      >
        <IconGlyph name="fitView" size={12} />
      </Button>

      <span aria-hidden className="bg-border mx-1 h-5 w-px" />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" trailing={<IconGlyph name="collapse" size={10} />}>
            {current}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {layouts.map((l) => (
            <MenuItem
              key={l.id}
              onSelect={() => setLayout(l.id)}
              trailing={l.id === layout ? <IconGlyph name="check" size={11} /> : undefined}
            >
              {l.label}
            </MenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
