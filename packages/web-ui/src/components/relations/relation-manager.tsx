'use client';

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Badge,
  Button,
  Card,
  Dialog,
  Field,
  Select,
  SimpleTooltip,
  useToast,
} from '@ship-it-ui/ui';
import { DynamicIconGlyph, IconGlyph } from '@ship-it-ui/icons';
import { getEntityTypeMeta } from '@ship-it-ui/shipit';
import {
  RelationEditError,
  createRelation,
  deleteRelation,
  fetchSchema,
  type GraphData,
  type SchemaRelTypeDef,
  type SchemaWithHash,
  type SearchResult,
} from '@/lib/api';
import { useCurrentUser } from '@/lib/current-user';
import { EntitySearchBox } from '@/components/search/entity-search-box';

// A relation row as seen from the *current* entity. `direction` is relative to
// it: `out` means current -[type]-> other (current is the edge's `from`), `in`
// means other -[type]-> current. Only `out` rows can be edited from this page
// (a manual edge is keyed by its from/to/type, and the current entity must be
// the `from` for an "outgoing" add/delete; inbound manual edges are managed
// from the other endpoint's page to keep from/to unambiguous).
interface RelationRow {
  direction: 'in' | 'out';
  /** The other endpoint's canonical id. */
  otherId: string;
  /** Relationship type (the Cypher rel type, e.g. DEPENDS_ON). */
  type: string;
  /** True iff the edge carries the positive `_manual_actor` provenance marker. */
  manual: boolean;
}

/**
 * The positive manual-provenance marker projected onto an edge by the
 * neighborhood serializer (`_manual_actor`, see RelationEditService). A
 * connector edge never carries it, so its presence is the single source of
 * truth for "deletable manual edge".
 */
function manualActorOf(edgeData: Record<string, unknown>): string | null {
  const v = edgeData['_manual_actor'];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Map a thrown relation-mutation error to friendly toast copy per code. */
function relationErrorToast(err: unknown): { title: string; description?: string } {
  if (err instanceof RelationEditError) {
    switch (err.code) {
      case 'CONNECTOR_EDGE':
        return {
          title: "Can't delete — connector-owned",
          description: 'A connector owns this relationship. It will return on the next sync.',
        };
      case 'INVALID_RELATION_TYPE':
        return {
          title: 'Unknown relationship type',
          description: 'That type is not in the current schema.',
        };
      case 'ENDPOINT_LABEL_MISMATCH':
        return {
          title: "Endpoints don't fit this relationship",
          description: 'The selected entities violate this type’s from/to constraints.',
        };
      case 'SELF_LOOP':
        return {
          title: "Can't link an entity to itself",
          description: 'Pick a different target entity.',
        };
      case 'ENDPOINT_NOT_FOUND':
        return {
          title: 'Entity not found',
          description: 'One endpoint may have been removed since this page loaded.',
        };
      case 'FEATURE_DISABLED':
        return {
          title: 'Manual editing is disabled',
          description: 'An administrator has turned off manual edits.',
        };
      case 'FORBIDDEN':
        return {
          title: "You don't have permission",
          description: 'You need graph-write access to edit relationships.',
        };
      case 'RATE_LIMITED':
        return {
          title: 'Too many edits, slow down',
          description: 'Wait a moment before editing again.',
        };
      case 'MANUAL_EDIT_DISABLED':
        return {
          title: 'Manual editing is unavailable',
          description: 'The manual-edit service is not configured.',
        };
      default:
        return { title: 'Relation edit failed', description: err.message };
    }
  }
  return {
    title: 'Relation edit failed',
    description: err instanceof Error ? err.message : undefined,
  };
}

/**
 * Dialog for authoring a manual relationship FROM the current entity. Type is
 * a schema-driven dropdown filtered (where possible) to types whose `from`
 * constraint matches the current entity's label, to avoid predictable 400s. The
 * target is picked via the shared entity-search-box, pre-filtered to the chosen
 * type's `to` label when one is declared.
 */
function AddRelationDialog({
  open,
  onOpenChange,
  entityId,
  entityLabel,
  relTypes,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityId: string;
  entityLabel: string;
  relTypes: Record<string, SchemaRelTypeDef>;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [type, setType] = useState('');
  const [target, setTarget] = useState<SearchResult | null>(null);

  // Type options: prefer the types whose `from` constraint matches this entity's
  // label (or have no `from` constraint). If that yields nothing (an entity
  // label the schema never sources a relation from), fall back to the full list
  // so the user is never hard-blocked — the server is still the final gate.
  const options = useMemo(() => {
    const all = Object.keys(relTypes).sort();
    const fitting = all.filter((t) => {
      const from = relTypes[t]?.from;
      return !from || from === entityLabel;
    });
    return fitting.length > 0 ? fitting : all;
  }, [relTypes, entityLabel]);

  const selectedDef = type ? relTypes[type] : undefined;
  // Pre-filter the target picker to the chosen type's `to` label when declared.
  const preferLabel = selectedDef?.to;

  const save = useMutation({
    mutationFn: () => createRelation(entityId, target!.id, type),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ['graph-neighborhood', entityId] });
      if (result.created) {
        toast({ variant: 'ok', title: 'Relationship added' });
      } else if (result.preexistingConnectorEdge) {
        toast({
          variant: 'warn',
          title: 'A connector already owns this relationship',
          description: 'Left untouched — no manual edge was created.',
        });
      } else {
        toast({ variant: 'default', title: 'You already added this relationship' });
      }
      onOpenChange(false);
    },
    onError: (err) => toast({ variant: 'err', ...relationErrorToast(err) }),
  });

  const canSubmit = type !== '' && target !== null && target.id !== entityId && !save.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Reset the draft whenever the dialog (re)opens so a stale pick doesn't
        // linger from a previous session.
        if (next) {
          setType('');
          setTarget(null);
        }
        onOpenChange(next);
      }}
      title="Add relationship"
      description="Create a manual relationship from this entity. Manual edges live alongside connector-ingested topology and can be removed later."
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={save.isPending}
          >
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={() => save.mutate()} disabled={!canSubmit}>
            {save.isPending ? 'Creating…' : 'Create relationship'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Field
          label="Relationship type"
          hint="Types are drawn from the live schema. Types that fit this entity are shown first."
        >
          {() => (
            <Select
              aria-label="Relationship type"
              placeholder="Choose a type…"
              options={options}
              value={type || undefined}
              onValueChange={(v) => {
                setType(v);
                // The `to` constraint may change, so a previously-picked target
                // could no longer fit — clear it to force a deliberate re-pick.
                setTarget(null);
              }}
            />
          )}
        </Field>

        <Field
          label="Target entity"
          hint={
            preferLabel
              ? `This type expects a ${preferLabel} target.`
              : 'Search for the entity to link to.'
          }
        >
          {() =>
            target ? (
              <div className="border-border bg-panel-2 rounded-base flex items-center gap-2 border px-3 py-2">
                {(() => {
                  const meta = getEntityTypeMeta(target.label);
                  return (
                    <span className={`leading-none ${meta.toneClass}`} aria-hidden>
                      <DynamicIconGlyph name={meta.iconName} size={15} />
                    </span>
                  );
                })()}
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-text truncate text-[13px] font-medium">{target.name}</span>
                  <span className="text-text-dim truncate font-mono text-[10px]">
                    {target.canonicalId}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-label="Clear target"
                  onClick={() => setTarget(null)}
                >
                  <IconGlyph name="close" size={12} />
                </Button>
              </div>
            ) : (
              <EntitySearchBox
                onSelect={(r) => setTarget(r)}
                placeholder="Search for an entity to link…"
                preferLabel={preferLabel}
              />
            )
          }
        </Field>

        {target?.id === entityId && (
          <p className="text-warn text-[11px]">An entity can&apos;t be linked to itself.</p>
        )}
      </div>
    </Dialog>
  );
}

function RelationRowItem({
  row,
  resolveName,
  resolveType,
  canWrite,
  onOpen,
  onDelete,
  deleting,
}: {
  row: RelationRow;
  resolveName: (id: string) => string | undefined;
  resolveType: (id: string) => string | undefined;
  canWrite: boolean;
  onOpen: (id: string) => void;
  onDelete: (row: RelationRow) => void;
  deleting: boolean;
}) {
  const name = resolveName(row.otherId) ?? row.otherId;
  const otherType = resolveType(row.otherId);
  const meta = otherType ? getEntityTypeMeta(otherType) : null;
  const arrow = row.direction === 'out' ? '→' : '←';

  // Delete is only ever offered on OUTGOING edges (current entity is the `from`)
  // — an inbound edge's from/to is owned by the other endpoint's page.
  const deletable = row.direction === 'out' && row.manual;

  return (
    <li className="hover:bg-panel-2/60 group flex items-center gap-3 rounded-sm px-2 py-2 text-[12px]">
      <button
        type="button"
        onClick={() => onOpen(row.otherId)}
        className="focus-visible:ring-accent-dim flex min-w-0 flex-1 items-center gap-3 rounded-sm text-left outline-none focus-visible:ring-[3px]"
      >
        <span aria-hidden className="text-text-dim w-3 font-mono text-[10px]">
          {arrow}
        </span>
        <span
          aria-hidden
          className={
            'grid h-6 w-6 place-items-center rounded-xs ' +
            (meta ? meta.toneBg + ' ' + meta.toneClass : 'bg-panel-2 text-text-dim')
          }
        >
          {meta ? (
            <DynamicIconGlyph name={meta.iconName} size={13} />
          ) : (
            <span className="font-mono text-[10px]">·</span>
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-text truncate">{name}</span>
          <span className="text-text-dim truncate font-mono text-[10px]">{row.type}</span>
        </span>
      </button>

      {row.manual ? (
        <Badge size="sm" variant="purple" icon={<IconGlyph name="person" size={10} />}>
          manual
        </Badge>
      ) : (
        <Badge size="sm" variant="neutral">
          connector
        </Badge>
      )}

      {canWrite &&
        row.direction === 'out' &&
        (deletable ? (
          <Button
            variant="ghost"
            size="sm"
            aria-label="Delete relationship"
            disabled={deleting}
            onClick={() => onDelete(row)}
          >
            <IconGlyph name="trash" size={12} />
          </Button>
        ) : (
          <SimpleTooltip content="A connector owns this relationship — it can't be deleted manually.">
            {/* Disabled buttons swallow pointer events, so wrap in a span the
                tooltip can anchor to. */}
            <span className="inline-flex">
              <Button
                variant="ghost"
                size="sm"
                aria-label="Delete relationship (connector-owned, disabled)"
                disabled
              >
                <IconGlyph name="lock" size={12} />
              </Button>
            </span>
          </SimpleTooltip>
        ))}
    </li>
  );
}

/**
 * The entity-detail Relationships card: lists the entity's relations (manual vs
 * connector), an Add affordance (graph:write only) that opens a schema-driven
 * dialog, and per-row delete for outgoing manual edges (connector edges show a
 * disabled, tooltip-explained control). All mutations invalidate the
 * neighborhood query so the list refreshes from source.
 */
export function RelationManager({
  entityId,
  entityLabel,
  data,
  onOpen,
}: {
  entityId: string;
  entityLabel: string;
  /** The neighborhood graph data (depth 1) the entity-detail page already loads. */
  data: GraphData | undefined;
  onOpen: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const user = useCurrentUser();
  // members + admins carry graph:write; wildcard `*` (dev-fallback admin) grants
  // everything. Anonymous / token-only principals lack it.
  const canWrite = user.capabilities.includes('graph:write') || user.capabilities.includes('*');
  const [addOpen, setAddOpen] = useState(false);

  // Reuse the shared `['schema']` query key (configure/schema page +
  // graph-canvas already populate it) so the dropdown's type list rides the
  // same cached round-trip rather than re-fetching.
  const { data: schemaWithHash } = useQuery<SchemaWithHash>({
    queryKey: ['schema'],
    queryFn: fetchSchema,
  });
  const relTypes = schemaWithHash?.schema.relationship_types ?? {};

  const rows = useMemo<RelationRow[]>(() => {
    if (!data) return [];
    const out: RelationRow[] = [];
    for (const e of data.edges) {
      const manualActor = manualActorOf(e.data);
      if (e.data.source === entityId) {
        out.push({
          direction: 'out',
          otherId: e.data.target,
          type: e.data.type,
          manual: manualActor !== null,
        });
      } else if (e.data.target === entityId) {
        out.push({
          direction: 'in',
          otherId: e.data.source,
          type: e.data.type,
          manual: manualActor !== null,
        });
      }
    }
    // Outgoing first (the editable direction), then by type for stable order.
    return out.sort((a, b) => {
      if (a.direction !== b.direction) return a.direction === 'out' ? -1 : 1;
      return a.type.localeCompare(b.type);
    });
  }, [data, entityId]);

  const resolveName = (id: string) =>
    data?.nodes.find((n) => n.data.id === id)?.data.name as string | undefined;
  const resolveType = (id: string) =>
    data?.nodes.find((n) => n.data.id === id)?.data.type as string | undefined;

  const del = useMutation({
    mutationFn: (row: RelationRow) => deleteRelation(entityId, row.otherId, row.type),
    onSuccess: (deleted) => {
      queryClient.invalidateQueries({ queryKey: ['graph-neighborhood', entityId] });
      toast({
        variant: 'ok',
        title: deleted ? 'Relationship removed' : 'Nothing to remove',
      });
    },
    onError: (err) => toast({ variant: 'err', ...relationErrorToast(err) }),
  });

  const confirmDelete = (row: RelationRow) => {
    const name = resolveName(row.otherId) ?? row.otherId;
    if (
      typeof window !== 'undefined' &&
      !window.confirm(`Remove the manual "${row.type}" relationship to ${name}?`)
    ) {
      return;
    }
    del.mutate(row);
  };

  return (
    <Card
      title={`Relationships (${rows.length})`}
      actions={
        canWrite ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<IconGlyph name="add" size={11} />}
            onClick={() => setAddOpen(true)}
          >
            Add relationship
          </Button>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <p className="text-text-muted text-[12px]">
          No relationships yet.
          {canWrite ? ' Use “Add relationship” to link this entity to another.' : ''}
        </p>
      ) : (
        <ul className="flex list-none flex-col gap-1 p-0">
          {rows.map((row) => (
            <RelationRowItem
              key={`${row.direction}-${row.otherId}-${row.type}`}
              row={row}
              resolveName={resolveName}
              resolveType={resolveType}
              canWrite={canWrite}
              onOpen={onOpen}
              onDelete={confirmDelete}
              deleting={del.isPending}
            />
          ))}
        </ul>
      )}

      {canWrite && (
        <AddRelationDialog
          open={addOpen}
          onOpenChange={setAddOpen}
          entityId={entityId}
          entityLabel={entityLabel}
          relTypes={relTypes}
        />
      )}
    </Card>
  );
}
