'use client';

import { PlaceholderPage } from '@/components/layout/placeholder-page';

export default function AgentActivityPage() {
  return (
    <PlaceholderPage
      title="Agent Activity"
      description="How AI agents are using the knowledge graph via MCP tools — invocations, hot entities, error patterns, and usage trends."
      glyph="sparkle"
      phase="phase-3"
      features={[
        'Time-series chart of MCP tool invocations, filterable by tool, agent, and window.',
        'Tabular call log: timestamp, tool, agent, parameters, response time, status.',
        'Most-queried entities — the "hot" nodes that agents reason about.',
        'Failed queries grouped by error code, with example queries and suggested fixes.',
        'Weekly / monthly trend deltas: total calls, unique agents, avg response time.',
      ]}
    />
  );
}
