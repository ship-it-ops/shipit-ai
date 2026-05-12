'use client';

import { PlaceholderPage } from '@/components/layout/placeholder-page';

export default function TeamDashboardPage() {
  return (
    <PlaceholderPage
      title="Team Dashboard"
      description="A team-scoped view of every service, repository, and deployment the team owns — with on-call, incidents, and recent activity rolled up in one place."
      glyph="person"
      phase="phase-2"
      features={[
        'Inventory of services, repos, and deployments owned by the team.',
        'On-call rotation pulled from PagerDuty / identity provider.',
        'Recent incidents and open work items filtered to the team.',
        'Activity feed of syncs, merges, and schema changes affecting team entities.',
        '"View Team Graph" jumps to Graph Explorer pre-filtered to the team.',
      ]}
    />
  );
}
