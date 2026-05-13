'use client';

import { PlaceholderPage } from '@/components/layout/placeholder-page';

export default function ReconciliationPage() {
  return (
    <PlaceholderPage
      title="Reconciliation"
      description="Queue of fuzzy-matched merge candidates that fell below the auto-merge threshold — review side-by-side and confirm, reject, or mark distinct."
      glyph="graph"
      phase="phase-2"
      features={[
        'Worklist of fuzzy-match candidates with score, source connectors, and proposed merge target.',
        'Side-by-side Entity Detail comparison: properties, claims, relationships.',
        'Confirm / reject / mark-distinct actions; merges record a MergeEvent in the graph.',
        'Per-label tuning of fuzzy-match threshold and feature weights.',
        'Reversal history — undo any merge within the configured rollback window.',
      ]}
    />
  );
}
