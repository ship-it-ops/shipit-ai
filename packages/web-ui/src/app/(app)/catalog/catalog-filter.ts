import type { FilterPanelValue } from '@ship-it-ui/ui';

export interface CatalogRow {
  id: string;
  name: string;
  type: string;
  owner: string;
  environment: string;
  tier: string;
  sourceSystem: string;
  sourceConnectorId: string;
  // Stable key used by the source facet — matches connectorIdentityKey().
  sourceKey: string;
}

// Entity types hidden from the catalog by default. Pipelines are high-volume
// and add a lot of noise to the default view; the user can re-show them by
// clearing the "Hide types" facet. Stateless: this default is re-applied on
// every page load and on Reset.
export const DEFAULT_EXCLUDED_TYPES = ['Pipeline'] as const;

/** The catalog's initial / reset filter state — Pipelines hidden by default. */
export function makeDefaultFilter(): FilterPanelValue {
  return { excludeTypes: [...DEFAULT_EXCLUDED_TYPES] };
}

// `FilterPanelValue` is `Record<string, ReadonlyArray<string>>`, so indexing a
// missing facet returns `undefined` at runtime even though the type says
// otherwise. Read optional facets through this helper.
function facetValues(filter: FilterPanelValue, key: string): readonly string[] {
  return (filter as Record<string, readonly string[] | undefined>)[key] ?? [];
}

/** True when this row's type is in the exclude ("Hide types") set. */
export function isExcludedByType(row: CatalogRow, filter: FilterPanelValue): boolean {
  const exclude = facetValues(filter, 'excludeTypes');
  return exclude.length > 0 && exclude.includes(row.type);
}

// Tri-state for a single entity type in the Type facet.
// neutral = no constraint · include = show only included types · exclude = hidden.
export type TypeState = 'neutral' | 'include' | 'exclude';

/** Current tri-state of a type: exclude wins, then include, else neutral. */
export function getTypeState(filter: FilterPanelValue, type: string): TypeState {
  if (facetValues(filter, 'excludeTypes').includes(type)) return 'exclude';
  if (facetValues(filter, 'types').includes(type)) return 'include';
  return 'neutral';
}

/**
 * Advance a type to its next tri-state and return a new filter:
 * neutral → include → exclude → neutral. The type lives in exactly one of the
 * `types` / `excludeTypes` arrays (or neither); other facets are preserved.
 */
export function cycleTypeState(filter: FilterPanelValue, type: string): FilterPanelValue {
  const without = (key: string) => facetValues(filter, key).filter((t) => t !== type);
  const next: Record<string, readonly string[]> = {
    ...(filter as Record<string, readonly string[]>),
  };
  switch (getTypeState(filter, type)) {
    case 'neutral': // → include
      next.types = [...without('types'), type];
      next.excludeTypes = without('excludeTypes');
      break;
    case 'include': // → exclude
      next.types = without('types');
      next.excludeTypes = [...without('excludeTypes'), type];
      break;
    case 'exclude': // → neutral
      next.types = without('types');
      next.excludeTypes = without('excludeTypes');
      break;
  }
  return next;
}

/**
 * Query + include-only facet matching (Type / Environment / Owner / Tier /
 * Source). Does NOT apply the exclude facet — see {@link matches}.
 */
export function matchesIncludes(row: CatalogRow, query: string, filter: FilterPanelValue): boolean {
  const q = query.trim().toLowerCase();
  if (q) {
    const haystack =
      `${row.name} ${row.id} ${row.type} ${row.owner} ${row.sourceSystem} ${row.sourceConnectorId}`.toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  const types = facetValues(filter, 'types');
  if (types.length && !types.includes(row.type)) return false;
  const environments = facetValues(filter, 'environments');
  if (environments.length && !environments.includes(row.environment)) return false;
  const owners = facetValues(filter, 'owners');
  if (owners.length && !owners.includes(row.owner)) return false;
  const tiers = facetValues(filter, 'tiers');
  if (tiers.length && !tiers.includes(row.tier)) return false;
  const sources = facetValues(filter, 'sources');
  if (sources.length) {
    // A selection matches the row if it's either the exact (type:instance)
    // key or the "any instance of this type" wildcard `${type}:*`.
    const typeWildcard = row.sourceSystem ? `${row.sourceSystem}:*` : '';
    const ok = sources.some((s) => s === row.sourceKey || (typeWildcard && s === typeWildcard));
    if (!ok) return false;
  }
  return true;
}

/**
 * Full visibility test for a catalog row: passes the include facets AND is not
 * removed by the exclude ("Hide types") facet. Exclude wins over include — a
 * type that is both included and excluded stays hidden.
 */
export function matches(row: CatalogRow, query: string, filter: FilterPanelValue): boolean {
  return matchesIncludes(row, query, filter) && !isExcludedByType(row, filter);
}

/**
 * How many rows are hidden *purely* by the exclude facet — i.e. they pass the
 * query and every include facet, and are removed only because their type is in
 * the exclude set. Powers the "Pipeline hidden · N" hint so the user knows the
 * default exclusion is in effect.
 */
export function countHiddenByExclude(
  rows: readonly CatalogRow[],
  query: string,
  filter: FilterPanelValue,
): number {
  return rows.filter((r) => matchesIncludes(r, query, filter) && isExcludedByType(r, filter))
    .length;
}
