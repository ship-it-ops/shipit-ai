'use client';

import { useState, type ReactNode } from 'react';
import { Field, Input, Select, WizardDialog, type WizardStep } from '@ship-it-ui/ui';
import { type GlyphName, IconGlyph } from '@ship-it-ui/icons';
import { cn } from '@/lib/utils';

interface ConnectorType {
  id: string;
  name: string;
  glyph: GlyphName;
  description: string;
}

const connectorTypes: ConnectorType[] = [
  {
    id: 'github',
    name: 'GitHub',
    glyph: 'github',
    description: 'Repositories, teams, workflows, CODEOWNERS',
  },
  {
    id: 'kubernetes',
    name: 'Kubernetes',
    glyph: 'kubernetes',
    description: 'Namespaces, deployments, services, pods',
  },
  {
    id: 'datadog',
    name: 'Datadog',
    glyph: 'datadog',
    description: 'Monitors, SLOs, service catalog',
  },
  {
    id: 'backstage',
    name: 'Backstage',
    glyph: 'backstage',
    description: 'Service catalog, APIs, documentation',
  },
  {
    id: 'jira',
    name: 'Jira',
    glyph: 'tag',
    description: 'Projects, issues, sprints',
  },
  {
    id: 'identity',
    name: 'Identity Provider',
    glyph: 'person',
    description: 'Users, groups, roles',
  },
];

interface AddConnectorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddConnectorDialog({ open, onOpenChange }: AddConnectorDialogProps) {
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [config, setConfig] = useState({ apiKey: '', baseUrl: '' });
  const [scope, setScope] = useState('');
  const [schedule, setSchedule] = useState('60');

  const selected = connectorTypes.find((c) => c.id === selectedType);

  const reset = () => {
    setSelectedType(null);
    setConfig({ apiKey: '', baseUrl: '' });
    setScope('');
    setSchedule('60');
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  const steps: WizardStep[] = [
    {
      id: 'select',
      label: 'Select type',
      canAdvance: () => Boolean(selectedType),
      content: (
        <div className="grid grid-cols-2 gap-3">
          {connectorTypes.map((ct) => (
            <button
              key={ct.id}
              type="button"
              onClick={() => setSelectedType(ct.id)}
              className={cn(
                'border-border bg-panel hover:border-border-strong flex items-start gap-3 rounded-md border p-3 text-left outline-none',
                'focus-visible:ring-accent-dim focus-visible:ring-[3px]',
                selectedType === ct.id && 'border-accent bg-accent-dim/40',
              )}
            >
              <span className="text-text-muted text-[22px] leading-none">
                <IconGlyph name={ct.glyph} size={22} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="text-text block text-[13px] font-medium">{ct.name}</span>
                <span className="text-text-muted block text-[11px]">{ct.description}</span>
              </span>
            </button>
          ))}
        </div>
      ),
    },
    {
      id: 'configure',
      label: 'Configure',
      content: selected ? (
        <div className="flex flex-col gap-4">
          <Field label="API key / token" required hint="Stored encrypted at rest">
            {(p) => (
              <Input
                {...p}
                type="password"
                placeholder="Enter your API key…"
                value={config.apiKey}
                onChange={(e) => setConfig({ ...config, apiKey: e.target.value })}
              />
            )}
          </Field>
          <Field label="Base URL" hint="Optional — defaults to public API">
            {(p) => (
              <Input
                {...p}
                type="url"
                placeholder="https://api.example.com"
                value={config.baseUrl}
                onChange={(e) => setConfig({ ...config, baseUrl: e.target.value })}
              />
            )}
          </Field>
        </div>
      ) : null,
    },
    {
      id: 'scope',
      label: 'Set scope',
      content: (
        <div className="flex flex-col gap-4">
          <Field label="Scope" hint="Glob patterns. Comma-separated.">
            {(p) => (
              <Input
                {...p}
                placeholder="org/*, team:payments-*"
                value={scope}
                onChange={(e) => setScope(e.target.value)}
              />
            )}
          </Field>
          <Field label="Sync schedule">
            {() => (
              <Select
                value={schedule}
                onValueChange={setSchedule}
                options={[
                  { value: '15', label: 'Every 15 minutes' },
                  { value: '60', label: 'Every 60 minutes' },
                  { value: '360', label: 'Every 6 hours' },
                  { value: '1440', label: 'Once a day' },
                ]}
              />
            )}
          </Field>
        </div>
      ),
    },
    {
      id: 'review',
      label: 'Review',
      content: selected ? (
        <ReviewSummary
          glyph={selected.glyph}
          name={selected.name}
          description={selected.description}
          rows={[
            { label: 'API key', value: '••••••••' },
            { label: 'Base URL', value: config.baseUrl || 'default' },
            { label: 'Scope', value: scope || 'all' },
            { label: 'Schedule', value: scheduleLabel(schedule) },
          ]}
        />
      ) : null,
    },
  ];

  return (
    <WizardDialog
      open={open}
      onOpenChange={handleOpenChange}
      steps={steps}
      title="Add connector"
      description="Connect a data source to populate your knowledge graph."
      width={560}
      completeLabel="Connect"
      cancelLabel="Cancel"
      onCancel={() => handleOpenChange(false)}
      onComplete={() => handleOpenChange(false)}
    />
  );
}

function scheduleLabel(value: string): string {
  return (
    {
      '15': 'Every 15 minutes',
      '60': 'Every 60 minutes',
      '360': 'Every 6 hours',
      '1440': 'Once a day',
    }[value] ?? 'Every 60 minutes'
  );
}

function ReviewSummary({
  glyph,
  name,
  description,
  rows,
}: {
  glyph: GlyphName;
  name: string;
  description: string;
  rows: ReadonlyArray<{ label: string; value: ReactNode }>;
}) {
  return (
    <div className="border-border bg-panel-2 rounded-md border p-4">
      <div className="mb-3 flex items-start gap-3">
        <span className="text-text-muted text-[24px] leading-none">
          <IconGlyph name={glyph} size={24} />
        </span>
        <div>
          <div className="text-text text-[14px] font-medium">{name}</div>
          <div className="text-text-muted text-[12px]">{description}</div>
        </div>
      </div>
      <dl className="m-0 flex flex-col gap-1 text-[12px]">
        {rows.map((row) => (
          <div
            key={row.label}
            className="border-border flex items-center justify-between border-t border-dashed py-1"
          >
            <dt className="text-text-muted font-mono text-[10px] tracking-[1.4px] uppercase">
              {row.label}
            </dt>
            <dd className="text-text font-mono">{row.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
