'use client';

import { useState } from 'react';
import { Badge, Button, Checkbox, Input, Select, Tooltip } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import type { SchemaNodeTypeDef, SchemaPropertyDef } from '@/lib/api';
import { PROPERTY_TYPES, RESOLUTION_STRATEGIES } from './strategy-options';

export interface PropertyEditorProps {
  typeName: string;
  def: SchemaNodeTypeDef;
  onChange: (next: SchemaNodeTypeDef) => void;
}

export function PropertyEditor({ typeName, def, onChange }: PropertyEditorProps) {
  const [newName, setNewName] = useState('');

  const updateProp = (name: string, patch: Partial<SchemaPropertyDef>) => {
    const next: SchemaNodeTypeDef = {
      ...def,
      properties: {
        ...def.properties,
        [name]: { ...def.properties[name], ...patch },
      },
    };
    onChange(next);
  };

  const removeProp = (name: string) => {
    const { [name]: _omit, ...rest } = def.properties;
    void _omit;
    onChange({ ...def, properties: rest });
  };

  const addProp = () => {
    const name = newName.trim();
    if (!name || def.properties[name]) return;
    onChange({
      ...def,
      properties: {
        ...def.properties,
        [name]: { type: 'string', resolution_strategy: 'HIGHEST_CONFIDENCE' },
      },
    });
    setNewName('');
  };

  const properties = Object.entries(def.properties).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-text text-[18px] font-semibold">{typeName}</h2>
          <p className="text-text-muted text-[12px]">{def.description}</p>
        </div>
        <Badge size="sm" variant="neutral">
          {properties.length} properties
        </Badge>
      </header>

      <div className="border-border bg-panel rounded-base overflow-hidden border">
        <table className="text-text w-full text-[12px]">
          <thead className="bg-panel-2 text-text-muted text-left">
            <tr>
              <th className="border-border border-b px-3 py-2 font-medium">Property</th>
              <th className="border-border border-b px-3 py-2 font-medium">Type</th>
              <th className="border-border border-b px-3 py-2 font-medium">Required</th>
              <th className="border-border border-b px-3 py-2 font-medium">Resolution strategy</th>
              <th className="border-border border-b px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {properties.map(([name, prop]) => (
              <PropertyRow
                key={name}
                name={name}
                prop={prop}
                isUniqueKey={def.constraints?.unique_key === name}
                onChange={(patch) => updateProp(name, patch)}
                onRemove={() => removeProp(name)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div className="border-border bg-panel-2 flex items-center gap-2 rounded-xs border p-2">
        <Input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="new_property_name"
          size="sm"
          onKeyDown={(e) => {
            if (e.key === 'Enter') addProp();
          }}
        />
        <Button size="sm" variant="outline" onClick={addProp} disabled={!newName.trim()}>
          <IconGlyph name="add" size={12} /> Add property
        </Button>
      </div>
    </div>
  );
}

function PropertyRow({
  name,
  prop,
  isUniqueKey,
  onChange,
  onRemove,
}: {
  name: string;
  prop: SchemaPropertyDef;
  isUniqueKey: boolean;
  onChange: (patch: Partial<SchemaPropertyDef>) => void;
  onRemove: () => void;
}) {
  const strategy = RESOLUTION_STRATEGIES.find((s) => s.value === prop.resolution_strategy);

  return (
    <tr className="border-border border-b align-top last:border-b-0">
      <td className="px-3 py-2 font-mono text-[12px]">
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-1">
            {name}
            {isUniqueKey && (
              <Badge size="sm" variant="purple" title="Unique key">
                key
              </Badge>
            )}
          </span>
          {prop.enum && <span className="text-text-dim text-[10px]">{prop.enum.join(' · ')}</span>}
        </div>
      </td>
      <td className="px-3 py-2">
        <Select
          options={PROPERTY_TYPES.map((t) => ({ value: t, label: t }))}
          value={prop.type}
          onValueChange={(v) => onChange({ type: v })}
          size="sm"
          aria-label={`${name} type`}
        />
      </td>
      <td className="px-3 py-2">
        <Checkbox
          checked={!!prop.required}
          onCheckedChange={(c) => onChange({ required: c === true })}
          aria-label={`${name} required`}
        />
      </td>
      <td className="px-3 py-2">
        <Tooltip content={strategy?.description ?? ''} side="top">
          <Select
            options={RESOLUTION_STRATEGIES.map((s) => ({ value: s.value, label: s.label }))}
            value={prop.resolution_strategy}
            onValueChange={(v) =>
              onChange({ resolution_strategy: v as SchemaPropertyDef['resolution_strategy'] })
            }
            size="sm"
            aria-label={`${name} resolution strategy`}
          />
        </Tooltip>
      </td>
      <td className="px-3 py-2 text-right">
        <Button
          variant="ghost"
          size="sm"
          onClick={onRemove}
          disabled={isUniqueKey}
          title={isUniqueKey ? 'Cannot remove the unique-key property' : 'Remove property'}
        >
          <IconGlyph name="close" size={12} />
        </Button>
      </td>
    </tr>
  );
}
