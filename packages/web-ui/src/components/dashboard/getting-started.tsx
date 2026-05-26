'use client';

import { useRouter } from 'next/navigation';
import { OnboardingChecklist, type OnboardingItem } from '@ship-it-ui/ui';
import { useConnectors } from '@/lib/hooks/use-connectors';

export function GettingStarted() {
  const router = useRouter();
  const { data: connectors = [] } = useConnectors();
  // After the multi-org rewrite, a connector's "connected" state is derived
  // from `enabled` plus the last run's outcome (a successful run means it's
  // healthy). Anything enabled with a non-failed last run counts.
  const connectedCount = connectors.filter(
    (c) => c.enabled && c.lastRuns[0]?.status !== 'failed',
  ).length;

  if (connectedCount >= 3) return null;

  const items: OnboardingItem[] = [
    {
      id: 'first-connector',
      label: 'Connect your first data source',
      description: 'Add a connector like GitHub to start populating the graph',
      status: connectedCount >= 1 ? 'done' : 'in-progress',
    },
    {
      id: 'explore-graph',
      label: 'Explore the knowledge graph',
      description: 'Navigate your software ecosystem visually',
      status: 'pending',
    },
    {
      id: 'second-connector',
      label: 'Add a second connector',
      description: 'Cross-reference data from multiple sources',
      status: connectedCount >= 2 ? 'done' : connectedCount >= 1 ? 'in-progress' : 'pending',
    },
  ];

  const targetById: Record<string, string> = {
    'first-connector': '/connectors',
    'explore-graph': '/explore',
    'second-connector': '/connectors',
  };

  return (
    <OnboardingChecklist
      title="Getting started"
      items={items}
      onItemClick={(id) => router.push(targetById[id] ?? '/')}
    />
  );
}
