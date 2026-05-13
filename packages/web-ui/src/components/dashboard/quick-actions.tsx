'use client';

import { useRouter } from 'next/navigation';
import { Card, Button } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { useUIStore } from '@/stores/ui-store';

export function QuickActions() {
  const router = useRouter();
  const { setSearchOpen } = useUIStore();

  return (
    <Card title="Quick Actions">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          icon={<IconGlyph name="add" />}
          onClick={() => router.push('/connectors')}
        >
          Add Connector
        </Button>
        <Button
          variant="outline"
          size="sm"
          icon={<IconGlyph name="graph" />}
          onClick={() => router.push('/explore')}
        >
          Explore Graph
        </Button>
        <Button
          variant="outline"
          size="sm"
          icon={<IconGlyph name="ask" />}
          onClick={() => router.push('/ask')}
        >
          Ask
        </Button>
        <Button
          variant="outline"
          size="sm"
          icon={<IconGlyph name="search" />}
          onClick={() => setSearchOpen(true)}
        >
          Search Entities
        </Button>
      </div>
    </Card>
  );
}
