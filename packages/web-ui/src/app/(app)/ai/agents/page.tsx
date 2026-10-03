'use client';

import { PlaceholderPage } from '@/components/layout/placeholder-page';

const NOTE =
  'This screen is a placeholder. Agents are being built now; the design is in docs/superpowers/specs/2026-10-01-ai-agents-and-workflows-design.md.';

export default function AgentsPage() {
  return (
    <PlaceholderPage
      title="Agents"
      description="Define AI agents: what they are for, which model they use, which tools they may call, and what starts them."
      glyph="bot"
      features={[
        'Name an agent, write its instructions, and pick a model.',
        'Grant tools per service with read, write and delete access set to off, allow or ask first.',
        'Test an agent in a side panel before publishing it.',
        'Start agents on a schedule, from a webhook, on a graph or GitHub event, or after another agent.',
      ]}
      note={NOTE}
    />
  );
}
