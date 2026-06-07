'use client';

import { GraphHealth } from '@/components/dashboard/graph-health';
import { StatsCards } from '@/components/dashboard/stats-cards';
import { QuickActions } from '@/components/dashboard/quick-actions';
import { ActivityFeed } from '@/components/dashboard/activity-feed';
import { GettingStarted } from '@/components/dashboard/getting-started';

export default function HomePage() {
  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-text text-[22px] font-semibold tracking-tight">Overview</h1>
        <p className="text-text-muted text-[13px]">Your software ecosystem at a glance</p>
      </header>

      <StatsCards />

      <div className="grid gap-6 lg:grid-cols-2">
        <div className="space-y-6">
          <GraphHealth />
          <QuickActions />
        </div>
        <div className="space-y-6">
          <ActivityFeed />
          <GettingStarted />
        </div>
      </div>
    </div>
  );
}
