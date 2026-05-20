'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, Dialog, EmptyState, Spinner } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { stringify as stringifyYaml } from 'yaml';
import {
  diffSchemaYaml,
  fetchSchema,
  migrationPreview,
  rollbackSchema,
  saveSchemaYaml,
  SchemaConflictError,
  type MigrationPreview,
  type SchemaDiff,
  type SchemaNodeTypeDef,
  type SchemaRelTypeDef,
  type SchemaWithHash,
  type ShipItSchema,
} from '@/lib/api';
import { NodeTypeList } from '@/components/schema/node-type-list';
import { PropertyEditor } from '@/components/schema/property-editor';
import { SchemaDiffView } from '@/components/schema/schema-diff';
import { HistoryDrawer } from '@/components/schema/history-drawer';
import { SchemaCanvas } from '@/components/schema/schema-canvas';

type EditorView = 'form' | 'visual';

function serialize(schema: ShipItSchema): string {
  // Keep top-level field order consistent with the existing on-disk format.
  return stringifyYaml(schema, { indent: 2 });
}

export default function SchemaEditorPage() {
  const queryClient = useQueryClient();
  const {
    data: serverPayload,
    isLoading,
    error,
    refetch,
  } = useQuery<SchemaWithHash>({ queryKey: ['schema'], queryFn: fetchSchema });
  const serverSchema = serverPayload?.schema;

  const [draft, setDraft] = useState<ShipItSchema | null>(null);
  /**
   * Hash of the server-side schema state the current draft was forked from.
   * Sent as `If-Match` on save so concurrent writers can't silently
   * clobber each other. Refreshed after a successful save / rollback.
   */
  const [baseHash, setBaseHash] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [diffPreview, setDiffPreview] = useState<SchemaDiff | null>(null);
  const [migration, setMigration] = useState<MigrationPreview | null>(null);
  const [diffOpen, setDiffOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [rollingBack, setRollingBack] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ serverHash: string } | null>(null);
  const [view, setView] = useState<EditorView>('form');

  // Reset the local draft any time the server schema changes (initial load,
  // rollback). Pick the first node type as the default selection.
  useEffect(() => {
    if (!serverPayload) return;
    setDraft(structuredClone(serverPayload.schema));
    setBaseHash(serverPayload.hash);
    setSelected((prev) => {
      const names = Object.keys(serverPayload.schema.node_types);
      if (prev && names.includes(prev)) return prev;
      return names[0] ?? null;
    });
  }, [serverPayload]);

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

  // Relationship changes don't surface in `dirty` (which the NodeTypeList uses
  // to badge node-type rows) but still need to enable Save. The visual editor's
  // drag-to-connect is relationship-only, so without this Save would never
  // light up for that flow.
  const relationshipsDirty = useMemo(() => {
    if (!draft || !serverSchema) return false;
    const draftRels = draft.relationship_types;
    const serverRels = serverSchema.relationship_types;
    const draftKeys = Object.keys(draftRels);
    const serverKeys = Object.keys(serverRels);
    if (draftKeys.length !== serverKeys.length) return true;
    for (const name of draftKeys) {
      const original = serverRels[name];
      if (!original || JSON.stringify(original) !== JSON.stringify(draftRels[name])) {
        return true;
      }
    }
    return false;
  }, [draft, serverSchema]);

  const hasChanges =
    dirty.size > 0 ||
    relationshipsDirty ||
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

  const updateNodeType = useCallback((name: string, next: SchemaNodeTypeDef) => {
    setDraft((d) => (d ? { ...d, node_types: { ...d.node_types, [name]: next } } : d));
  }, []);

  const addNodeType = useCallback((name: string) => {
    setDraft((d) =>
      d
        ? {
            ...d,
            node_types: {
              ...d.node_types,
              [name]: { description: '', properties: {} },
            },
          }
        : d,
    );
    setSelected(name);
  }, []);

  // Deleting a node type cascades to relationships that reference it —
  // otherwise the schema-service validator rejects the YAML on save and the
  // user has to manually clean up dangling rels.
  const deleteNodeType = useCallback((name: string) => {
    setDraft((d) => {
      if (!d) return d;
      const { [name]: _omitNode, ...remainingNodes } = d.node_types;
      void _omitNode;
      const remainingRels = Object.fromEntries(
        Object.entries(d.relationship_types).filter(
          ([, def]) => def.from !== name && def.to !== name,
        ),
      );
      return { ...d, node_types: remainingNodes, relationship_types: remainingRels };
    });
    setSelected((prev) => (prev === name ? null : prev));
  }, []);

  const addRelationship = useCallback((name: string, def: SchemaRelTypeDef) => {
    setDraft((d) =>
      d ? { ...d, relationship_types: { ...d.relationship_types, [name]: def } } : d,
    );
  }, []);

  const updateRelationship = useCallback((name: string, def: SchemaRelTypeDef) => {
    setDraft((d) =>
      d ? { ...d, relationship_types: { ...d.relationship_types, [name]: def } } : d,
    );
  }, []);

  const deleteRelationship = useCallback((name: string) => {
    setDraft((d) => {
      if (!d) return d;
      const { [name]: _omit, ...rest } = d.relationship_types;
      void _omit;
      return { ...d, relationship_types: rest };
    });
  }, []);

  const openSaveDialog = useCallback(async () => {
    if (!draft) return;
    setSaveError(null);
    setMigration(null);
    try {
      const yaml = serialize(draft);
      // Run diff + migration preview in parallel — migration preview reads
      // from Neo4j and can be slower; no reason to gate the dialog open on
      // both finishing.
      const [diff, preview] = await Promise.all([
        diffSchemaYaml(yaml),
        migrationPreview(yaml).catch((e) => {
          // Don't block the save flow if migration preview fails — surface
          // the error inline in the dialog instead. The diff itself is the
          // load-bearing check; impact counts are advisory.
          console.warn('migration-preview failed:', e);
          return null;
        }),
      ]);
      setDiffPreview(diff);
      setMigration(preview);
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
      await saveSchemaYaml(yaml, baseHash ?? undefined);
      await refetch();
      await queryClient.invalidateQueries({ queryKey: ['schema-history'] });
      setDiffOpen(false);
      setDiffPreview(null);
      setMigration(null);
    } catch (e) {
      if (e instanceof SchemaConflictError) {
        // Server-side state moved under the user. Stop the save flow and
        // surface the dedicated conflict dialog so they can pick a recovery
        // path (discard + reload, or keep editing against the new base).
        setConflict({ serverHash: e.serverHash });
        setDiffOpen(false);
      } else {
        setSaveError((e as Error).message);
      }
    } finally {
      setSaving(false);
    }
  }, [draft, baseHash, refetch, queryClient]);

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

  const discardAndReload = useCallback(async () => {
    setConflict(null);
    await refetch();
  }, [refetch]);

  const keepEditingAgainstNewBase = useCallback(() => {
    // Adopt the server's current hash as the new base so the next save
    // attempt isn't auto-rejected. The user's draft is preserved verbatim;
    // they can re-open the diff dialog to see what changed.
    if (conflict) setBaseHash(conflict.serverHash);
    setConflict(null);
  }, [conflict]);

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
          <div className="border-border bg-panel inline-flex overflow-hidden rounded-xs border">
            <button
              type="button"
              onClick={() => setView('form')}
              className={
                'flex items-center gap-1 px-3 py-1.5 text-[12px] font-medium transition-colors ' +
                (view === 'form'
                  ? 'bg-panel-2 text-text'
                  : 'text-text-muted hover:text-text hover:bg-panel-2/60')
              }
              aria-pressed={view === 'form'}
            >
              <IconGlyph name="list" size={11} /> Form
            </button>
            <button
              type="button"
              onClick={() => setView('visual')}
              className={
                'flex items-center gap-1 px-3 py-1.5 text-[12px] font-medium transition-colors ' +
                (view === 'visual'
                  ? 'bg-panel-2 text-text'
                  : 'text-text-muted hover:text-text hover:bg-panel-2/60')
              }
              aria-pressed={view === 'visual'}
            >
              <IconGlyph name="graph" size={11} /> Visual
            </button>
          </div>
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

      {view === 'form' ? (
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
      ) : (
        <div className="min-h-0 flex-1">
          <SchemaCanvas
            schema={draft}
            selected={selected}
            onSelect={setSelected}
            onUpdateNode={updateNodeType}
            onAddNode={addNodeType}
            onDeleteNode={deleteNodeType}
            onAddRelationship={addRelationship}
            onUpdateRelationship={updateRelationship}
            onDeleteRelationship={deleteRelationship}
          />
        </div>
      )}

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
        {diffPreview ? <SchemaDiffView diff={diffPreview} migration={migration} /> : null}
      </Dialog>

      <Dialog
        open={conflict !== null}
        onOpenChange={(o) => !o && setConflict(null)}
        title="Schema changed under you"
        description="Another writer saved the schema between your read and this save. Choose how to recover."
        width={520}
        footer={
          <div className="flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" onClick={keepEditingAgainstNewBase}>
              Keep my edits
            </Button>
            <Button size="sm" onClick={discardAndReload}>
              Discard + reload
            </Button>
          </div>
        }
      >
        <div className="text-text-muted flex flex-col gap-2 text-[13px]">
          <p>Your draft is still in place — nothing has been lost. Pick a path:</p>
          <ul className="m-0 list-disc pl-5">
            <li>
              <strong>Discard + reload</strong> pulls the new server state and drops your unsaved
              edits.
            </li>
            <li>
              <strong>Keep my edits</strong> adopts the server&apos;s current version as the new
              base; your next save will overwrite whatever the other writer just committed. Re-open
              the diff to see what changed first.
            </li>
          </ul>
        </div>
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
