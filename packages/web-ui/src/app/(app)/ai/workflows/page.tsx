'use client';

import { PlaceholderPage } from '@/components/layout/placeholder-page';

const NOTE =
  'This screen is a placeholder. Workflows arrive after agents; the design is in docs/superpowers/specs/2026-10-01-ai-agents-and-workflows-design.md.';

export default function WorkflowsPage() {
  return (
    <PlaceholderPage
      title="Workflows"
      description="Wire several agents together on a canvas, with branches, parallel steps, approval gates and bounded loops."
      glyph="workflow"
      features={[
        'Drag agents onto a canvas and connect them.',
        'Branch on an agent’s result, run steps in parallel, and join them again.',
        'Hold a step until a person approves it.',
        'Watch a run move through the canvas node by node.',
      ]}
      note={NOTE}
    />
  );
}
