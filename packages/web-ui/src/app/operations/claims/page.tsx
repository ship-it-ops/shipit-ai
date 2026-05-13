'use client';

import { PlaceholderPage } from '@/components/layout/placeholder-page';

export default function ClaimExplorerPage() {
  return (
    <PlaceholderPage
      title="Claim Explorer"
      description="Per-entity, per-property view of every PropertyClaim — who said what, when, with what confidence, and which one won (and why)."
      glyph="check"
      phase="phase-2"
      features={[
        'Per-property claim list with source connector, confidence, timestamp, and evidence link.',
        '"Why this value won" — surfaces the resolution strategy and the discarded claims.',
        'Manual-override workflow: assert a human claim that takes priority over connectors.',
        'Filters: by source, by low-confidence, by recently-changed, by conflicting properties.',
        'Bulk-resolution actions for sweeping property overrides across many entities.',
      ]}
    />
  );
}
