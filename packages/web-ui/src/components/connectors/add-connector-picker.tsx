'use client';

// Generic "Add connector" entry point. Lists every connector type ShipIt
// plans to support, with the ones that aren't wired up yet flagged as
// "Coming soon". Clicking GitHub closes this dialog and opens the
// GitHub-specific wizard — the page coordinates the two.
//
// Keeping the picker as its own component (rather than baking type
// selection into each connector wizard) means a future Kubernetes / Datadog
// wizard can be added behind its own button without re-touching the
// GitHub flow.

import { Badge, Dialog } from '@ship-it-ui/ui';
import { IconGlyph, type GlyphName } from '@ship-it-ui/icons';
import { cn } from '@/lib/utils';

export type ConnectorTypeId =
  | 'github'
  | 'kubernetes'
  | 'datadog'
  | 'backstage'
  | 'jira'
  | 'identity';

interface ConnectorType {
  id: ConnectorTypeId;
  name: string;
  glyph: GlyphName;
  description: string;
  // Disabled types are listed for discoverability (so admins see the
  // roadmap) but can't be picked. The badge text below distinguishes
  // "coming soon" (planned) from anything else we want to surface later.
  status: 'available' | 'coming-soon';
}

const CONNECTOR_TYPES: ConnectorType[] = [
  {
    id: 'github',
    name: 'GitHub',
    glyph: 'github',
    description: 'Repositories, teams, members, workflows, CODEOWNERS',
    status: 'available',
  },
  {
    id: 'kubernetes',
    name: 'Kubernetes',
    glyph: 'kubernetes',
    description: 'Namespaces, deployments, services, pods',
    status: 'coming-soon',
  },
  {
    id: 'datadog',
    name: 'Datadog',
    glyph: 'datadog',
    description: 'Monitors, SLOs, service catalog, on-call',
    status: 'coming-soon',
  },
  {
    id: 'backstage',
    name: 'Backstage',
    glyph: 'backstage',
    description: 'Service catalog, APIs, documentation',
    status: 'coming-soon',
  },
  {
    id: 'jira',
    name: 'Jira',
    glyph: 'tag',
    description: 'Projects, issues, sprints, releases',
    status: 'coming-soon',
  },
  {
    id: 'identity',
    name: 'Identity provider',
    glyph: 'person',
    description: 'Users, groups, roles (Okta / Entra / Google Workspace)',
    status: 'coming-soon',
  },
];

interface AddConnectorPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Invoked when the user picks a connector type that's wired up. The
  // page handler is responsible for closing this dialog and opening the
  // type-specific wizard. Passing through `ConnectorTypeId` keeps the
  // surface ready for the second connector (likely Kubernetes) without
  // a refactor.
  onPick: (type: ConnectorTypeId) => void;
}

export function AddConnectorPicker({ open, onOpenChange, onPick }: AddConnectorPickerProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add connector"
      description="Connect a data source to populate your knowledge graph. More integrations are on the roadmap — see the badges below."
      width={620}
    >
      <div className="grid grid-cols-2 gap-3">
        {CONNECTOR_TYPES.map((ct) => {
          const disabled = ct.status !== 'available';
          return (
            <button
              key={ct.id}
              type="button"
              disabled={disabled}
              onClick={() => onPick(ct.id)}
              aria-label={disabled ? `${ct.name} — coming soon` : `${ct.name} — ${ct.description}`}
              className={cn(
                'border-border bg-panel hover:border-border-strong flex items-start gap-3 rounded-md border p-3 text-left transition outline-none',
                'focus-visible:ring-accent-dim focus-visible:ring-[3px]',
                disabled && 'hover:border-border cursor-not-allowed opacity-60',
              )}
            >
              <span className="text-text-muted text-[22px] leading-none">
                <IconGlyph name={ct.glyph} size={22} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-text flex items-center gap-2 text-[14px] font-medium">
                  {ct.name}
                  {ct.status === 'coming-soon' && (
                    <Badge variant="neutral" size="sm">
                      Coming soon
                    </Badge>
                  )}
                </span>
                <span className="text-text-muted mt-0.5 block text-[12px]">{ct.description}</span>
              </span>
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}
