'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Badge, Button, Card, Dialog, EmptyState, Spinner } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { stringify as stringifyYaml } from 'yaml';
import {
  diffSchemaYaml,
  fetchSchema,
  rollbackSchema,
  saveSchemaYaml,
  type SchemaDiff,
  type SchemaNodeTypeDef,
  type ShipItSchema,
} from '@/lib/api';
import { NodeTypeList } from '@/components/schema/node-type-list';
import { PropertyEditor } from '@/components/schema/property-editor';
import { SchemaDiffView } from '@/components/schema/schema-diff';
import { HistoryDrawer } from '@/components/schema/history-drawer';

function serialize(schema: ShipItSchema): string {
  // Keep top-level field order consistent with the existing on-disk format.
  return stringifyYaml(schema, { indent: 2 });
}

export default function SchemaEditorPage() {
  const queryClient = useQueryClient();
  const {
    data: serverSchema,
    isLoading,
    error,
    refetch,
  } = useQuery<ShipItSchema>({ queryKey: ['schema'], queryFn: fetchSchema });

  const [draft, setDraft] = useState<ShipItSchema | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diffPreview, setDiffPreview] = useState<SchemaDiff | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Reset the local draft any time the server schema changes (initial load,
  // rollback). Pick the first node type as the default selection.
  useEffect(() => {
    if (!serverSchema) return;
    setDraft(structuredClone(serverSchema));
    setSelected((prev) => {
      const names = Object.keys(serverSchema.node_types);
      if (prev && names.includes(prev)) return prev;
      return names[0] ?? null;
    });
  }, [serverSchema]);

  const dirty = useMemo(() => {
    const out = new Set<string>();
    if (!draft || !serverSchema) return out;
    for (const name of Object.keys(draft.node_types)) {
      const original = serverSchema.node_types[name];
      const next = draft.node_types[name];
      if (!original || JSON.stringify(original) !== JSON.stringify(next)) {
        out.add(name);
      }
    }
    return out;
  }, [draft, serverSchema]);

  const hasChanges =
    dirty.size > 0 ||
    (draft &&
      serverSchema &&
      Object.keys(draft.node_types).length !== Object.keys(serverSchema.node_types).length);

  const updateSelected = useCallback(
    (next: SchemaNodeTypeDef) => {
      if (!draft || !selected) return;
      setDraft({
        ...draft,
        node_types: { ...draft.node_types, [selected]: next },
      });
    },
    [draft, selected],
  );

  const openSaveDialog = useCallback(async () => {
    if (!draft) return;
    setSaveError(null);
    try {
      const yaml = serialize(draft);
      const diff = await diffSchemaYaml(yaml);
      setDiffPreview(diff);
      setDiffOpen(true);
    } catch (e) {
      setSaveError((e as Error).message);
    }
  }, [draft]);

  const confirmSave = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError(null);
    try {
      const yaml = serialize(draft);
      await saveSchemaYaml(yaml);
      await refetch();
      await queryClient.invalidateQueries({ queryKey: ['schema-history'] });
      setDiffOpen(false);
      setDiffPreview(null);
    } catch (e) {
      setSaveError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }, [draft, refetch, queryClient]);

  const doRollback = useCallback(
    async (version: string) => {
      setRollingBack(version);
      try {
        await rollbackSchema(version);
        await refetch();
        await queryClient.invalidateQueries({ queryKey: ['schema-history'] });
        setHistoryOpen(false);
      } catch (e) {
        setSaveError((e as Error).message);
      } finally {
        setRollingBack(null);
      }
    },
    [refetch, queryClient],
  );

  if (isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }
  if (error || !draft) {
    return (
      <div className="p-6">
        <EmptyState
          tone="err"
          icon={<IconGlyph name="warn" size={22} />}
          title="Failed to load schema"
          description={(error as Error | null)?.message ?? 'Unknown error'}
        />
      </div>
    );
  }

  const currentDef = selected ? draft.node_types[selected] : null;

  return (
    <div className="flex h-full flex-col">
      <header className="border-border flex items-start justify-between gap-4 border-b px-6 py-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-text text-[22px] font-semibold tracking-tight">Schema Editor</h1>
            <Badge variant="accent">Phase 2</Badge>
            <span className="text-text-dim text-[11px]">
              v{draft.version} · {draft.mode} mode
            </span>
          </div>
          <p className="text-text-muted mt-1 text-[13px]">
            Form-based ontology management — properties, types, and per-property resolution
            strategies.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)}>
            <IconGlyph name="file" size={12} /> History
          </Button>
          <Button onClick={openSaveDialog} disabled={!hasChanges || saving} size="sm">
            {saving ? <Spinner size="sm" /> : <IconGlyph name="check" size={12} />}
            Save changes
          </Button>
        </div>
      </header>

      {saveError && (
        <div className="mx-6 mt-3 rounded-xs border border-[color:var(--color-err)]/40 bg-[color:var(--color-err)]/10 px-3 py-2 text-[12px] text-[color:var(--color-err)]">
          {saveError}
        </div>
      )}

      <div className="grid min-h-0 flex-1 grid-cols-[260px_1fr] gap-0">
        <aside className="border-border min-h-0 overflow-y-auto border-r p-3">
          <NodeTypeList schema={draft} selected={selected} onSelect={setSelected} dirty={dirty} />
        </aside>
        <main className="min-h-0 overflow-y-auto p-6">
          {currentDef && selected ? (
            <PropertyEditor typeName={selected} def={currentDef} onChange={updateSelected} />
          ) : (
            <Card title="Select a node type">
              <p className="text-text-muted text-[12px]">
                Pick a type from the list on the left to edit its properties.
              </p>
            </Card>
          )}
        </main>
      </div>

      <Dialog
        open={diffOpen}
        onOpenChange={(o) => !o && setDiffOpen(false)}
        title="Review changes"
        description="Confirm the diff against the currently saved schema. A snapshot of the previous version will be written to history before the change applies."
        width={640}
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setDiffOpen(false)}
              disabled={saving}
            >
              Cancel
            </Button>
            <Button size="sm" onClick={confirmSave} disabled={saving}>
              {saving ? <Spinner size="sm" /> : null}
              Apply
            </Button>
          </div>
        }
      >
        {diffPreview ? <SchemaDiffView diff={diffPreview} /> : null}
      </Dialog>

      <HistoryDrawer
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onRollback={doRollback}
        rollingBack={rollingBack}
      />
    </div>
  );
}
