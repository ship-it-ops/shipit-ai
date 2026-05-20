'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import {
  GraphEditorCanvas,
  GraphNodeShell,
  type GraphEditorCanvasHandle,
  type GraphElement,
  type NodeRenderProps,
} from '@ship-it-ui/graph-editor';
import { Handle, Position } from '@xyflow/react';
import { Badge, Button, Dialog, Field, Input, Select } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import type { EntityType } from '@ship-it-ui/shipit';
import type { SchemaNodeTypeDef, SchemaRelTypeDef, ShipItSchema } from '@/lib/api';
import { PropertyEditor } from './property-editor';

export interface SchemaCanvasProps {
  schema: ShipItSchema;
  selected: string | null;
  onSelect: (name: string | null) => void;
  onUpdateNode: (name: string, def: SchemaNodeTypeDef) => void;
  onAddNode: (name: string) => void;
  onDeleteNode: (name: string) => void;
  onAddRelationship: (name: string, def: SchemaRelTypeDef) => void;
  onUpdateRelationship: (name: string, def: SchemaRelTypeDef) => void;
  onDeleteRelationship: (name: string) => void;
}

const CARDINALITIES: ReadonlyArray<SchemaRelTypeDef['cardinality']> = ['1:1', '1:N', 'N:1', 'N:M'];

// Used by the layout fallback when a node-type hasn't been dragged yet.
// Three-column grid keeps the canvas readable on first paint.
const LAYOUT_GAP = 180;
const LAYOUT_COLS = 3;
const LAYOUT_ORIGIN = { x: 80, y: 80 };

function defaultPosition(index: number): { x: number; y: number } {
  return {
    x: LAYOUT_ORIGIN.x + (index % LAYOUT_COLS) * LAYOUT_GAP,
    y: LAYOUT_ORIGIN.y + Math.floor(index / LAYOUT_COLS) * LAYOUT_GAP,
  };
}

interface PendingConnect {
  source: string;
  target: string;
}

interface PendingAdd {
  position: { x: number; y: number };
}

export function SchemaCanvas({
  schema,
  selected,
  onSelect,
  onUpdateNode,
  onAddNode,
  onDeleteNode,
  onAddRelationship,
  onUpdateRelationship,
  onDeleteRelationship,
}: SchemaCanvasProps) {
  const canvasRef = useRef<GraphEditorCanvasHandle | null>(null);

  // Positions are an editor-only concern — the schema doesn't store them.
  // In-memory map keyed by node-type name; survives view-toggle within a
  // session but resets on page nav. Persist later if users complain.
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);

  const [pendingConnect, setPendingConnect] = useState<PendingConnect | null>(null);
  const [pendingAdd, setPendingAdd] = useState<PendingAdd | null>(null);

  const elements = useMemo<GraphElement[]>(() => {
    const nodeNames = Object.keys(schema.node_types);

    // Group self-loops (from === to) by node-type so the custom renderer
    // can surface them as a ↻ badge instead of drawing a degenerate edge.
    // React Flow renders source===target edges as a tiny stub that looks
    // broken; the badge is both honest about the relationship existing
    // and easier to scan than three pixels of stub.
    const selfLoopsByNode: Record<string, string[]> = {};
    for (const [name, def] of Object.entries(schema.relationship_types)) {
      if (def.from === def.to && def.from in schema.node_types) {
        (selfLoopsByNode[def.from] ??= []).push(name);
      }
    }

    const nodes: GraphElement[] = nodeNames.map((name, i) => ({
      data: {
        id: name,
        label: name,
        // `entityType` drives the icon + color in the default node renderer.
        // Unregistered names fall back to centered text — that's a fine
        // signal for newly-added custom node types.
        entityType: name,
        // Custom field consumed by `renderSchemaNode`. The DS adapter
        // preserves unknown `data` keys verbatim across round-trip.
        selfLoops: selfLoopsByNode[name] ?? [],
      },
      position: positions[name] ?? defaultPosition(i),
    }));

    // Only render non-self-loop relationships whose endpoints still exist.
    // Dangling edges would crash React Flow the same way they crash
    // Cytoscape; the page's delete-node handler already cascades, but
    // belt-and-braces.
    const edges: GraphElement[] = Object.entries(schema.relationship_types)
      .filter(
        ([, def]) =>
          def.from !== def.to && def.from in schema.node_types && def.to in schema.node_types,
      )
      .map(([name, def]) => ({
        data: {
          id: name,
          source: def.from,
          target: def.to,
          label: name,
        },
      }));

    return [...nodes, ...edges];
  }, [schema, positions]);

  const handleNodeMove = useCallback((nodeId: string, position: { x: number; y: number }) => {
    setPositions((prev) => ({ ...prev, [nodeId]: position }));
  }, []);

  const handleSelect = useCallback(
    (target: { kind: 'node' | 'edge'; id: string }) => {
      if (target.kind === 'node') {
        setSelectedEdge(null);
        onSelect(target.id);
      } else {
        setSelectedEdge(target.id);
        onSelect(null);
      }
    },
    [onSelect],
  );

  const handleClearSelection = useCallback(() => {
    setSelectedEdge(null);
    onSelect(null);
  }, [onSelect]);

  // Canvas fires onConnect with an auto-generated id for the temp edge it
  // drew. We open the relationship dialog; on confirm we undo() the temp
  // edge first so the canvas reconciles cleanly against our schema-derived
  // edge keyed by relationship name. On cancel we just undo().
  const handleConnect = useCallback((edge: { id: string; source: string; target: string }) => {
    setPendingConnect({ source: edge.source, target: edge.target });
  }, []);

  const handleNodeAdd = useCallback((node: { id: string; position: { x: number; y: number } }) => {
    setPendingAdd({ position: node.position });
  }, []);

  const handleNodeDelete = useCallback(
    (nodeId: string) => {
      // The page's delete handler cascades to referencing relationships.
      onDeleteNode(nodeId);
      setPositions((prev) => {
        const { [nodeId]: _omit, ...rest } = prev;
        void _omit;
        return rest;
      });
    },
    [onDeleteNode],
  );

  const handleEdgeDelete = useCallback(
    (edgeId: string) => {
      onDeleteRelationship(edgeId);
      if (selectedEdge === edgeId) setSelectedEdge(null);
    },
    [onDeleteRelationship, selectedEdge],
  );

  const confirmConnect = useCallback(
    (name: string, cardinality: SchemaRelTypeDef['cardinality'], description: string) => {
      if (!pendingConnect) return;
      // Drop the canvas's temp edge so we don't end up with both the temp
      // and our schema-derived edge for the same connection.
      canvasRef.current?.undo();
      onAddRelationship(name, {
        from: pendingConnect.source,
        to: pendingConnect.target,
        cardinality,
        description: description || undefined,
      });
      setPendingConnect(null);
    },
    [pendingConnect, onAddRelationship],
  );

  const cancelConnect = useCallback(() => {
    canvasRef.current?.undo();
    setPendingConnect(null);
  }, []);

  const confirmAdd = useCallback(
    (name: string) => {
      if (!pendingAdd) return;
      canvasRef.current?.undo();
      onAddNode(name);
      setPositions((prev) => ({ ...prev, [name]: pendingAdd.position }));
      setPendingAdd(null);
      onSelect(name);
    },
    [pendingAdd, onAddNode, onSelect],
  );

  const cancelAdd = useCallback(() => {
    canvasRef.current?.undo();
    setPendingAdd(null);
  }, []);

  const inspector = useMemo(() => {
    if (selectedEdge) {
      const def = schema.relationship_types[selectedEdge];
      if (!def) return null;
      return (
        <RelationshipInspector
          name={selectedEdge}
          def={def}
          onChange={(next) => onUpdateRelationship(selectedEdge, next)}
          onDelete={() => onDeleteRelationship(selectedEdge)}
        />
      );
    }
    if (selected) {
      const def = schema.node_types[selected];
      if (!def) return null;
      // Self-loops that touch this type. Listed in the inspector since
      // they're invisible on the canvas — clicking one re-targets the
      // inspector to the relationship-edit form.
      const selfLoops = Object.entries(schema.relationship_types).filter(
        ([, rel]) => rel.from === rel.to && rel.from === selected,
      );
      return (
        <div className="border-border bg-bg max-h-full w-[420px] overflow-y-auto rounded-md border p-4 shadow-lg">
          <PropertyEditor
            typeName={selected}
            def={def}
            onChange={(next) => onUpdateNode(selected, next)}
          />
          {selfLoops.length > 0 && (
            <div className="border-border mt-4 flex flex-col gap-1 border-t pt-3">
              <span className="text-text-muted text-[11px] tracking-wider uppercase">
                Self-references
              </span>
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {selfLoops.map(([name, rel]) => (
                  <li key={name}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedEdge(name);
                        onSelect(null);
                      }}
                      className="border-border bg-panel hover:bg-panel-2 flex w-full items-center justify-between gap-2 rounded-xs border px-2 py-1.5 text-left text-[12px]"
                    >
                      <span className="font-mono">{name}</span>
                      <span className="text-text-dim font-mono text-[10px]">{rel.cardinality}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="border-border mt-4 flex justify-end border-t pt-3">
            <Button variant="ghost" size="sm" onClick={() => onDeleteNode(selected)}>
              <IconGlyph name="close" size={12} /> Delete type
            </Button>
          </div>
        </div>
      );
    }
    return (
      <div className="border-border bg-bg text-text-muted w-[320px] rounded-md border p-4 text-[12px] shadow-lg">
        <p className="m-0">
          Select a node type or relationship to edit. Drag from a node to another to create a
          relationship; press <kbd>Delete</kbd> on a selected node to remove it.
        </p>
      </div>
    );
  }, [
    schema,
    selected,
    selectedEdge,
    onSelect,
    onUpdateNode,
    onDeleteNode,
    onUpdateRelationship,
    onDeleteRelationship,
  ]);

  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <GraphEditorCanvas
        ref={canvasRef}
        elements={elements}
        background="dots"
        miniMap
        renderNode={renderSchemaNode}
        onSelect={handleSelect}
        onClearSelection={handleClearSelection}
        onConnect={handleConnect}
        onNodeAdd={handleNodeAdd}
        onNodeMove={handleNodeMove}
        onNodeDelete={handleNodeDelete}
        onEdgeDelete={handleEdgeDelete}
        inspector={inspector}
        aria-label="Schema visual editor"
        className="h-full w-full"
      />

      {pendingAdd && (
        <AddNodeTypeDialog
          existing={schema.node_types}
          onConfirm={confirmAdd}
          onCancel={cancelAdd}
        />
      )}

      {pendingConnect && (
        <RelationshipPickerDialog
          from={pendingConnect.source}
          to={pendingConnect.target}
          existing={schema.relationship_types}
          onConfirm={confirmConnect}
          onCancel={cancelConnect}
        />
      )}
    </div>
  );
}

// --- Dialogs ----------------------------------------------------------------

interface AddNodeTypeDialogProps {
  existing: ShipItSchema['node_types'];
  onConfirm: (name: string) => void;
  onCancel: () => void;
}

function AddNodeTypeDialog({ existing, onConfirm, onCancel }: AddNodeTypeDialogProps) {
  const [name, setName] = useState('');
  const trimmed = name.trim();
  const conflict = trimmed.length > 0 && trimmed in existing;
  const invalid = trimmed.length === 0 || conflict;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onCancel()}
      title="New node type"
      description="Choose a name. You can edit the description and properties from the inspector after creating it."
      width={420}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={invalid} onClick={() => onConfirm(trimmed)}>
            Create
          </Button>
        </div>
      }
    >
      <Field
        label="Name"
        error={conflict ? `A type named "${trimmed}" already exists.` : undefined}
      >
        {(p) => (
          <Input
            {...p}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., FeatureFlag"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !invalid) onConfirm(trimmed);
            }}
          />
        )}
      </Field>
    </Dialog>
  );
}

interface RelationshipPickerDialogProps {
  from: string;
  to: string;
  existing: ShipItSchema['relationship_types'];
  onConfirm: (
    name: string,
    cardinality: SchemaRelTypeDef['cardinality'],
    description: string,
  ) => void;
  onCancel: () => void;
}

function RelationshipPickerDialog({
  from,
  to,
  existing,
  onConfirm,
  onCancel,
}: RelationshipPickerDialogProps) {
  const [name, setName] = useState('');
  const [cardinality, setCardinality] = useState<SchemaRelTypeDef['cardinality']>('1:N');
  const [description, setDescription] = useState('');

  const trimmed = name.trim();
  const conflict = trimmed.length > 0 && trimmed in existing;
  const invalid = trimmed.length === 0 || conflict;

  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onCancel()}
      title="New relationship"
      description={`Connecting ${from} → ${to}. Pick a relationship name and cardinality.`}
      width={460}
      footer={
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={invalid}
            onClick={() => onConfirm(trimmed, cardinality, description.trim())}
          >
            Create
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          label="Relationship name"
          error={conflict ? `A relationship named "${trimmed}" already exists.` : undefined}
        >
          {(p) => (
            <Input
              {...p}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., DEPENDS_ON"
              autoFocus
            />
          )}
        </Field>
        <Field label="Cardinality">
          {() => (
            <Select
              options={CARDINALITIES.map((c) => ({ value: c, label: c }))}
              value={cardinality}
              onValueChange={(v) => setCardinality(v as SchemaRelTypeDef['cardinality'])}
            />
          )}
        </Field>
        <Field label="Description (optional)">
          {(p) => (
            <Input
              {...p}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this relationship represents"
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}

// --- Edge inspector ---------------------------------------------------------

interface RelationshipInspectorProps {
  name: string;
  def: SchemaRelTypeDef;
  onChange: (next: SchemaRelTypeDef) => void;
  onDelete: () => void;
}

function RelationshipInspector({ name, def, onChange, onDelete }: RelationshipInspectorProps) {
  return (
    <div className="border-border bg-bg w-[340px] rounded-md border p-4 shadow-lg">
      <header className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-text text-[16px] font-semibold">{name}</h2>
        <Badge size="sm" variant="neutral">
          relationship
        </Badge>
      </header>
      <div className="flex flex-col gap-3">
        <Field label="From">{(p) => <Input {...p} value={def.from} disabled />}</Field>
        <Field label="To">{(p) => <Input {...p} value={def.to} disabled />}</Field>
        <Field label="Cardinality">
          {() => (
            <Select
              options={CARDINALITIES.map((c) => ({ value: c, label: c }))}
              value={def.cardinality}
              onValueChange={(v) =>
                onChange({ ...def, cardinality: v as SchemaRelTypeDef['cardinality'] })
              }
            />
          )}
        </Field>
        <Field label="Description">
          {(p) => (
            <Input
              {...p}
              value={def.description ?? ''}
              onChange={(e) => onChange({ ...def, description: e.target.value || undefined })}
              placeholder="Optional"
            />
          )}
        </Field>
        <div className="border-border flex justify-end border-t pt-3">
          <Button variant="ghost" size="sm" onClick={onDelete}>
            <IconGlyph name="close" size={12} /> Delete relationship
          </Button>
        </div>
      </div>
    </div>
  );
}

// --- Custom node renderer ---------------------------------------------------

/**
 * Schema-aware node renderer. Mirrors the DS `<DefaultNode>` (shell + four
 * Handles for drag-to-connect) and overlays a small `↻ N` badge when the
 * node has self-referencing relationships in the schema. We don't draw
 * self-loop edges on the canvas — React Flow renders source===target as a
 * degenerate stub — so the badge is the canonical signal that a self-rel
 * exists.
 */
function renderSchemaNode(props: NodeRenderProps): React.ReactNode {
  const { id, data, selected } = props;
  const entityType = (data.entityType as EntityType | undefined) ?? id;
  const label = (data.label as string | undefined) ?? id;
  const selfLoops = Array.isArray(data.selfLoops) ? (data.selfLoops as string[]) : [];

  return (
    <div className="relative">
      <Handle type="target" position={Position.Top} className="ship-graph-handle" />
      <Handle type="target" position={Position.Left} className="ship-graph-handle" />
      <Handle type="source" position={Position.Right} className="ship-graph-handle" />
      <Handle type="source" position={Position.Bottom} className="ship-graph-handle" />
      <GraphNodeShell type={entityType} state={selected ? 'selected' : 'default'} label={label} />
      {selfLoops.length > 0 && (
        <span
          aria-label={`${selfLoops.length} self-referencing relationship${selfLoops.length === 1 ? '' : 's'}: ${selfLoops.join(', ')}`}
          title={`Self-references: ${selfLoops.join(', ')}`}
          className="border-bg bg-accent text-bg pointer-events-auto absolute -top-1 -right-1 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full border-2 px-1 font-mono text-[10px] leading-none font-semibold"
        >
          ↻{selfLoops.length > 1 ? ` ${selfLoops.length}` : ''}
        </span>
      )}
    </div>
  );
}
