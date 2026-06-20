'use client';

import { useState } from 'react';
import { Banner, Field, Input, Select } from '@ship-it-ui/ui';
import { CUSTOM, SCHEDULE_PRESETS, WARNING_TEXT, isTooFrequent, matchPreset } from '@/lib/schedule';

const SELECT_OPTIONS = [
  ...SCHEDULE_PRESETS.map((p) => ({ value: p.value, label: p.label })),
  { value: CUSTOM, label: 'Custom cron…' },
];

/**
 * Controlled sync-schedule picker shared by the add-connector wizard and the
 * connector detail drawer. Presents friendly presets (defaulting to 30 min) with
 * a "Custom cron…" escape hatch, and shows a concise, non-blocking warning when
 * the chosen cadence is frequent enough to strain the system.
 */
export function ScheduleField({
  value,
  onChange,
}: {
  value: string;
  onChange: (cron: string) => void;
}) {
  const [customMode, setCustomMode] = useState(() => matchPreset(value) === CUSTOM);

  // Re-derive the mode when the value is replaced from outside (e.g. the drawer
  // resetting to a different connector's schedule). This "adjust state during
  // render" pattern (https://react.dev/learn/you-might-not-need-an-effect)
  // avoids an effect: when the incoming value matches a preset we drop back to
  // the dropdown; a non-preset value (including the user's own custom edits)
  // keeps the raw input shown.
  const [prevValue, setPrevValue] = useState(value);
  if (value !== prevValue) {
    setPrevValue(value);
    setCustomMode(matchPreset(value) === CUSTOM);
  }

  const selectValue = customMode ? CUSTOM : matchPreset(value);

  const handleSelect = (next: string) => {
    if (next === CUSTOM) {
      setCustomMode(true);
      return; // keep the current value as the starting point for editing
    }
    setCustomMode(false);
    onChange(next);
  };

  return (
    <Field
      label="Sync schedule"
      hint="How often this connector polls for missed webhooks. Default: every 30 minutes."
    >
      {(p) => (
        <div className="flex flex-col gap-2" aria-describedby={p['aria-describedby']}>
          <Select
            options={SELECT_OPTIONS}
            value={selectValue}
            onValueChange={handleSelect}
            aria-label="Sync schedule preset"
          />
          {customMode && (
            <Input
              value={value}
              onChange={(e) => onChange(e.target.value)}
              placeholder="*/30 * * * *"
              aria-label="Custom cron schedule"
              aria-invalid={p['aria-invalid']}
            />
          )}
          {isTooFrequent(value) && <Banner tone="warn">{WARNING_TEXT}</Banner>}
        </div>
      )}
    </Field>
  );
}
