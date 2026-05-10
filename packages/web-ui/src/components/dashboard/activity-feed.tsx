'use client';

import { useQuery } from '@tanstack/react-query';
import { Card, Timeline, type TimelineEvent, type TimelineEventTone } from '@ship-it-ui/ui';
import { fetchActivity, type ActivityEvent } from '@/lib/api';

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const eventTone: Record<ActivityEvent['type'], TimelineEventTone> = {
  sync: 'accent',
  merge: 'muted',
  schema_change: 'warn',
  connector_added: 'ok',
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

  const timelineEvents: TimelineEvent[] = events.map((e) => ({
    title: e.message,
    time: formatRelativeTime(e.timestamp),
    tone: eventTone[e.type],
  }));

  return (
    <Card title="Recent Activity">
      <div className="max-h-[280px] overflow-y-auto pr-2">
        <Timeline events={timelineEvents} />
      </div>
    </Card>
  );
}
