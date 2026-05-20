'use client';

import { PlaceholderPage } from '@/components/layout/placeholder-page';

export default function AccessControlPage() {
  return (
    <PlaceholderPage
      title="Access Control"
      description="Role-based access with graph-level ACLs — read/write permissions per node label, relationship, and data source, plus a per-role MCP tool allowlist for AI agents."
      glyph="settings"
      features={[
        'Roles + groups; SAML / OIDC group sync.',
        'Graph-level ACLs: per node label, per relationship type, per source connector.',
        'Per-role MCP tool allowlist — restrict which tools each AI agent can call.',
        'Inline conflict-of-permissions checker before applying role changes.',
        'Audit trail of every permission change (links to Audit Log).',
      ]}
    />
  );
}
