'use client';

import { useState, type ReactNode } from 'react';
import {
  Dialog,
  Button,
  Field,
  Input,
  Select,
  Stepper,
} from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { cn } from '@/lib/utils';

interface ConnectorType {
  id: string;
  name: string;
  glyph: string;
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

const steps = ['Select type', 'Configure', 'Set scope', 'Review'] as const;

interface AddConnectorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddConnectorDialog({ open, onOpenChange }: AddConnectorDialogProps) {
  const [step, setStep] = useState(0);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [config, setConfig] = useState({ apiKey: '', baseUrl: '' });
  const [scope, setScope] = useState('');
  const [schedule, setSchedule] = useState('60');

  const selected = connectorTypes.find((c) => c.id === selectedType);

  const reset = () => {
    setStep(0);
    setSelectedType(null);
    setConfig({ apiKey: '', baseUrl: '' });
    setScope('');
    setSchedule('60');
  };

  const handleOpenChange = (next: boolean) => {
    if (!next) reset();
    onOpenChange(next);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={handleOpenChange}
      width={560}
      title="Add connector"
      description="Connect a data source to populate your knowledge graph."
      footer={
        <>
          {step > 0 && (
            <Button
              variant="outline"
              icon={<IconGlyph name="prev" />}
              onClick={() => setStep(step - 1)}
            >
              Back
            </Button>
          )}
          {step < steps.length - 1 ? (
            <Button
              trailing={<IconGlyph name="next" />}
              disabled={step === 0 && !selectedType}
              onClick={() => setStep(step + 1)}
            >
              Next
            </Button>
          ) : (
            <Button icon={<IconGlyph name="check" />} onClick={() => handleOpenChange(false)}>
              Connect
            </Button>
          )}
        </>
      }
    >
      <div className="mb-4">
        <Stepper steps={steps as unknown as string[]} current={step} />
      </div>

      <StepBody
        step={step}
        selectedType={selectedType}
        onSelectType={setSelectedType}
        selected={selected}
        config={config}
        onConfigChange={setConfig}
        scope={scope}
        onScopeChange={setScope}
        schedule={schedule}
        onScheduleChange={setSchedule}
      />
    </Dialog>
  );
}

interface StepBodyProps {
  step: number;
  selectedType: string | null;
  onSelectType: (id: string) => void;
  selected: ConnectorType | undefined;
  config: { apiKey: string; baseUrl: string };
  onConfigChange: (next: { apiKey: string; baseUrl: string }) => void;
  scope: string;
  onScopeChange: (value: string) => void;
  schedule: string;
  onScheduleChange: (value: string) => void;
}

function StepBody({
  step,
  selectedType,
  onSelectType,
  selected,
  config,
  onConfigChange,
  scope,
  onScopeChange,
  schedule,
  onScheduleChange,
}: StepBodyProps) {
  return (
    <div className="min-h-[220px]">
      {step === 0 && (
        <div className="grid grid-cols-2 gap-3">
          {connectorTypes.map((ct) => (
            <button
              key={ct.id}
              type="button"
              onClick={() => onSelectType(ct.id)}
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
      )}

      {step === 1 && selected && (
        <div className="flex flex-col gap-4">
          <Field label="API key / token" required hint="Stored encrypted at rest">
            {(p) => (
              <Input
                {...p}
                type="password"
                placeholder="Enter your API key…"
                value={config.apiKey}
                onChange={(e) => onConfigChange({ ...config, apiKey: e.target.value })}
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
                onChange={(e) => onConfigChange({ ...config, baseUrl: e.target.value })}
              />
            )}
          </Field>
        </div>
      )}

      {step === 2 && (
        <div className="flex flex-col gap-4">
          <Field label="Scope" hint="Glob patterns. Comma-separated.">
            {(p) => (
              <Input
                {...p}
                placeholder="org/*, team:payments-*"
                value={scope}
                onChange={(e) => onScopeChange(e.target.value)}
              />
            )}
          </Field>
          <Field label="Sync schedule">
            {() => (
              <Select
                value={schedule}
                onValueChange={onScheduleChange}
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
      )}

      {step === 3 && selected && (
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
      )}
    </div>
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
  glyph: string;
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
