'use client';

import { useQuery } from '@tanstack/react-query';
import {
  ActivityTimeline,
  Card,
  ScrollArea,
  type ActivityEvent as TimelineActivityEvent,
  type TimelineEventTone,
} from '@ship-it-ui/ui';
import { type GlyphName, IconGlyph } from '@ship-it-ui/icons';
import { fetchActivity, type ActivityEvent } from '@/lib/api';

const eventTone: Record<ActivityEvent['type'], TimelineEventTone> = {
  sync: 'accent',
  merge: 'muted',
  schema_change: 'warn',
  connector_added: 'ok',
};

const eventGlyph: Record<ActivityEvent['type'], GlyphName> = {
  sync: 'refresh',
  merge: 'graph',
  schema_change: 'schema',
  connector_added: 'add',
};

export function ActivityFeed() {
  const { data: events = [] } = useQuery<ActivityEvent[]>({
    queryKey: ['activity'],
    queryFn: fetchActivity,
    retry: 1,
    refetchInterval: 30_000,
  });

  if (events.length === 0) {
    return (
      <Card title="Recent Activity">
        <p className="text-text-muted text-[13px]">No activity yet</p>
      </Card>
    );
  }

  const timelineEvents: TimelineActivityEvent[] = events.map((e) => ({
    id: e.id,
    title: e.message,
    at: e.timestamp,
    tone: eventTone[e.type],
    icon: <IconGlyph name={eventGlyph[e.type]} size={12} />,
    actor: e.connector ? { name: e.connector } : undefined,
  }));

  return (
    <Card title="Recent Activity">
      <ScrollArea className="h-[280px] pr-2">
        <ActivityTimeline events={timelineEvents} />
      </ScrollArea>
    </Card>
  );
}
