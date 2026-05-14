'use client';

import { Badge } from '@ship-it-ui/ui';
import type { ShipItSchema } from '@/lib/api';

export interface NodeTypeListProps {
  schema: ShipItSchema;
  selected: string | null;
  onSelect: (name: string) => void;
  dirty: Set<string>;
}

export function NodeTypeList({ schema, selected, onSelect, dirty }: NodeTypeListProps) {
  const names = Object.keys(schema.node_types).sort();
  return (
    <ul className="flex list-none flex-col gap-[2px] p-0">
      {names.map((name) => {
        const def = schema.node_types[name];
        const propCount = Object.keys(def.properties).length;
        const isSelected = name === selected;
        const isDirty = dirty.has(name);
        return (
          <li key={name}>
            <button
              type="button"
              onClick={() => onSelect(name)}
              className={
                'border-border bg-panel hover:bg-panel-2 flex w-full items-center justify-between gap-2 rounded-xs border px-2 py-2 text-left transition-colors ' +
                (isSelected ? 'border-accent bg-accent-dim' : '')
              }
            >
              <div className="flex flex-col gap-[2px]">
                <span className="text-text flex items-center gap-1 text-[12px] font-medium">
                  {name}
                  {isDirty && <Badge size="sm" variant="warn">edited</Badge>}
                </span>
                <span className="text-text-dim text-[10px]">{propCount} properties</span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
