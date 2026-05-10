'use client';

import { useRouter } from 'next/navigation';
import { Card } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { cn } from '@/lib/utils';
import { useConnectors } from '@/lib/hooks/use-connectors';

interface ChecklistItem {
  label: string;
  description: string;
  href: string;
  glyph: string;
  completed: boolean;
}

export function GettingStarted() {
  const router = useRouter();
  const { data: connectors = [] } = useConnectors();
  const connectedCount = connectors.filter((c) => c.status !== 'not_connected').length;

  if (connectedCount >= 3) return null;

  const items: ChecklistItem[] = [
    {
      label: 'Connect your first data source',
      description: 'Add a connector like GitHub to start populating the graph',
      href: '/connectors',
      glyph: 'bolt',
      completed: connectedCount >= 1,
    },
    {
      label: 'Explore the knowledge graph',
      description: 'Navigate your software ecosystem visually',
      href: '/explore',
      glyph: 'graph',
      completed: false,
    },
    {
      label: 'Add a second connector',
      description: 'Cross-reference data from multiple sources',
      href: '/connectors',
      glyph: 'add',
      completed: connectedCount >= 2,
    },
  ];

  return (
    <Card title="Getting Started">
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {items.map((item) => (
          <li key={item.label}>
            <button
              type="button"
              onClick={() => router.push(item.href)}
              className="hover:bg-panel-2 focus-visible:ring-accent-dim rounded-xs flex w-full items-start gap-3 p-2 text-left outline-none focus-visible:ring-[3px]"
            >
              <span
                aria-hidden
                className={cn(
                  'mt-[2px] grid h-5 w-5 shrink-0 place-items-center rounded-full text-[10px]',
                  item.completed
                    ? 'bg-ok text-on-accent'
                    : 'bg-panel-2 border-border text-text-dim border',
                )}
              >
                {item.completed ? '✓' : <IconGlyph name={item.glyph} size={11} />}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    'block text-[13px] font-medium',
                    item.completed && 'text-text-muted line-through',
                  )}
                >
                  {item.label}
                </span>
                <span className="text-text-dim block text-[12px]">{item.description}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}
