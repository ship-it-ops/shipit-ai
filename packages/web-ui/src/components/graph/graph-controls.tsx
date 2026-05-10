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

export function GraphControls() {
  const { layout, setLayout } = useGraphStore();
  const current = layouts.find((l) => l.id === layout)?.label ?? 'Layout';

  return (
    <div className="border-border bg-panel flex items-center gap-1 rounded-md border p-[3px]">
      <Button variant="ghost" size="sm" aria-label="Zoom in">
        <IconGlyph name="add" size={12} />
      </Button>
      <Button variant="ghost" size="sm" aria-label="Zoom out">
        <IconGlyph name="remove" size={12} />
      </Button>
      <Button variant="ghost" size="sm" aria-label="Fit to screen">
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
