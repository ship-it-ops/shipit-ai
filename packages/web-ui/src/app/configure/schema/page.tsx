'use client';

import { PlaceholderPage } from '@/components/layout/placeholder-page';

export default function SchemaEditorPage() {
  return (
    <PlaceholderPage
      title="Schema Editor"
      description="Form-based ontology management — node types, properties, relationships, and per-property resolution strategies. Drag-and-drop visual editing is deferred beyond Phase 2."
      glyph="schema"
      phase="phase-2"
      features={[
        'Node-type list with property definitions and per-property resolution-strategy dropdowns.',
        'Live preview: pick a strategy, see how it would resolve a sample claim conflict.',
        'Add / remove operations with impact analysis ("this will delete N nodes and M edges").',
        'Pre-apply validation: duplicate labels, dangling endpoints, circular definitions.',
        'Read-only Cytoscape meta-graph of the current schema.',
        'Version history with diffs and rollback for the last 10 versions.',
      ]}
    />
  );
}
