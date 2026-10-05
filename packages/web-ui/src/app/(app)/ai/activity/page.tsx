'use client';

import { PlaceholderPage } from '@/components/layout/placeholder-page';

const NOTE =
  'This screen is a placeholder. Activity arrives with agents; the design is in docs/superpowers/specs/2026-10-01-ai-agents-and-workflows-design.md.';

export default function ActivityPage() {
  return (
    <PlaceholderPage
      title="Activity"
      description="Runs of your agents and workflows, the tool calls they made, and approvals waiting on a person."
      glyph="activity"
      features={[
        'Run list with agent, trigger, status, tokens and duration.',
        'A full transcript per run: every model turn and tool call, with its service, effect and decision.',
        'An approvals inbox for write and delete actions held for a person.',
        'Later: calls made by external MCP clients, alongside our own agents.',
      ]}
      note={NOTE}
    />
  );
}
