'use client';

import { PlaceholderPage } from '@/components/layout/placeholder-page';

const NOTE =
  'This screen is a placeholder. Tools arrive with agents; the design is in docs/superpowers/specs/2026-10-01-ai-agents-and-workflows-design.md.';

export default function ToolsPage() {
  return (
    <PlaceholderPage
      title="Tools"
      description="Everything an agent can call, grouped by service, with whether each tool reads, writes or deletes."
      glyph="package"
      features={[
        'The built-in graph tools, the same ones external MCP clients use.',
        'Connections to external MCP servers, with each tool classified before agents may use it.',
        'The GitHub actions App that lets agents commit to a branch and open a pull request.',
      ]}
      note={NOTE}
    />
  );
}
