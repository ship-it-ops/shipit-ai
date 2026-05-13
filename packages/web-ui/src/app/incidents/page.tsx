'use client';

import { Card, EmptyState, Input } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';

export default function IncidentModePage() {
  return (
    <div className="flex h-full flex-col items-center justify-center p-6">
      <div className="w-full max-w-2xl space-y-6">
        <EmptyState
          tone="err"
          icon={<IconGlyph name="incident" size={22} />}
          title="Incident Mode"
          description="Quick blast radius analysis for on-call incident response."
        />

        <Input
          size="lg"
          icon={<IconGlyph name="search" size={14} />}
          placeholder="What service is having problems?"
          autoFocus
        />

        <Card title="How it works">
          <ol className="text-text-muted m-0 flex list-none flex-col gap-2 p-0 text-[13px]">
            <li>1. Search for the affected service by name.</li>
            <li>2. View downstream blast radius in production.</li>
            <li>3. See affected teams and on-call contacts.</li>
            <li>4. Review recent changes to the service and its neighbors.</li>
          </ol>
        </Card>
      </div>
    </div>
  );
}
