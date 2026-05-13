'use client';

import { PlaceholderPage } from '@/components/layout/placeholder-page';

export default function QueryPlaygroundPage() {
  return (
    <PlaceholderPage
      title="Query Playground"
      description="Free-form Cypher against the live knowledge graph, with saved queries and an analyzer for slow paths."
      glyph="cmd"
      phase="phase-2"
      features={[
        'Cypher editor with syntax highlighting and schema-aware autocomplete.',
        'Result grid with column filters, JSON inspector, and CSV export.',
        'Saved queries with team-shared bookmarks and parameterization.',
        'Read-only by default; write queries require a per-user override.',
        'Query analyzer flags slow scans and suggests index candidates.',
      ]}
    />
  );
}
