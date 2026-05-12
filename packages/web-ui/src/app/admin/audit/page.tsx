'use client';

import { PlaceholderPage } from '@/components/layout/placeholder-page';

export default function AuditLogPage() {
  return (
    <PlaceholderPage
      title="Audit Log"
      description="Tamper-evident log of every schema change, manual claim override, and merge action — filterable, exportable, and streamable to an external SIEM."
      glyph="file"
      phase="enterprise"
      features={[
        'Append-only log of schema, claim, merge, and access-control changes.',
        'Filter by actor, entity, action type, and date range.',
        'Export to CSV; webhook stream to Splunk / Datadog / S3 / a custom SIEM.',
        'Configurable retention (default 12 months).',
        'Tamper-evidence via per-entry signed hash chain.',
      ]}
    />
  );
}
