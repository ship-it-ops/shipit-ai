import { describe, it, expect } from 'vitest';
import type { FilterPanelValue } from '@ship-it-ui/ui';
import {
  type CatalogRow,
  matches,
  makeDefaultFilter,
  countHiddenByExclude,
  getTypeState,
  cycleTypeState,
  DEFAULT_EXCLUDED_TYPES,
} from './catalog-filter';

function arr(filter: FilterPanelValue, key: string): readonly string[] {
  return (filter as Record<string, readonly string[] | undefined>)[key] ?? [];
}

function row(partial: Partial<CatalogRow> & { type: string; name: string }): CatalogRow {
  return {
    id: partial.id ?? `${partial.type}:${partial.name}`,
    name: partial.name,
    type: partial.type,
    owner: partial.owner ?? '',
    environment: partial.environment ?? '',
    tier: partial.tier ?? '',
    sourceSystem: partial.sourceSystem ?? '',
    sourceConnectorId: partial.sourceConnectorId ?? '',
    sourceKey: partial.sourceKey ?? 'unknown',
  };
}

const svc = row({ type: 'LogicalService', name: 'checkout' });
const repo = row({ type: 'Repository', name: 'web' });
const pipe = row({ type: 'Pipeline', name: 'deploy' });

describe('catalog-filter', () => {
  it('default filter excludes Pipeline but keeps everything else', () => {
    const f = makeDefaultFilter();
    expect(DEFAULT_EXCLUDED_TYPES).toContain('Pipeline');
    expect(matches(svc, '', f)).toBe(true);
    expect(matches(repo, '', f)).toBe(true);
    expect(matches(pipe, '', f)).toBe(false);
  });

  it('clearing the exclude set reveals pipelines', () => {
    const f: FilterPanelValue = { excludeTypes: [] };
    expect(matches(pipe, '', f)).toBe(true);
  });

  it('exclude wins over include — a type in both include and exclude stays hidden', () => {
    const both: FilterPanelValue = { types: ['Pipeline'], excludeTypes: ['Pipeline'] };
    expect(matches(pipe, '', both)).toBe(false);

    // a non-excluded, included type still shows
    const includeRepo: FilterPanelValue = { types: ['Repository'], excludeTypes: ['Pipeline'] };
    expect(matches(repo, '', includeRepo)).toBe(true);
  });

  it('counts rows hidden purely by the exclude filter', () => {
    const rows = [svc, repo, pipe, row({ type: 'Pipeline', name: 'release' })];
    expect(countHiddenByExclude(rows, '', makeDefaultFilter())).toBe(2);
  });

  it('exclude hidden-count respects the search query', () => {
    const rows = [pipe, row({ type: 'Pipeline', name: 'release' })];
    expect(countHiddenByExclude(rows, 'deploy', makeDefaultFilter())).toBe(1);
  });

  it('does not count a pipeline already filtered out by an include facet as hidden-by-exclude', () => {
    // This pipeline fails the environment include filter, so it is not "hidden
    // by the exclude facet" — it would be invisible regardless of exclusion.
    const stagingPipe = row({ type: 'Pipeline', name: 'p', environment: 'staging' });
    const f: FilterPanelValue = { environments: ['production'], excludeTypes: ['Pipeline'] };
    expect(countHiddenByExclude([stagingPipe], '', f)).toBe(0);
    expect(matches(stagingPipe, '', f)).toBe(false);
  });
});

describe('tri-state type cycling', () => {
  it('getTypeState reflects neutral / include / exclude', () => {
    expect(getTypeState({}, 'Repository')).toBe('neutral');
    expect(getTypeState({ types: ['Repository'] }, 'Repository')).toBe('include');
    expect(getTypeState({ excludeTypes: ['Pipeline'] }, 'Pipeline')).toBe('exclude');
  });

  it('cycles neutral → include → exclude → neutral', () => {
    let f: FilterPanelValue = {};
    f = cycleTypeState(f, 'Repository');
    expect(getTypeState(f, 'Repository')).toBe('include');
    f = cycleTypeState(f, 'Repository');
    expect(getTypeState(f, 'Repository')).toBe('exclude');
    f = cycleTypeState(f, 'Repository');
    expect(getTypeState(f, 'Repository')).toBe('neutral');
  });

  it('moving include → exclude removes the type from the include set', () => {
    const f = cycleTypeState({ types: ['Repository'] }, 'Repository');
    expect(arr(f, 'types')).not.toContain('Repository');
    expect(arr(f, 'excludeTypes')).toContain('Repository');
  });

  it('preserves other facets and other types when cycling', () => {
    const f = cycleTypeState({ environments: ['production'], types: ['Repository'] }, 'Pipeline');
    expect(arr(f, 'environments')).toEqual(['production']);
    expect(arr(f, 'types')).toContain('Repository');
    expect(getTypeState(f, 'Pipeline')).toBe('include');
  });

  it('default filter puts Pipeline in the exclude state', () => {
    expect(getTypeState(makeDefaultFilter(), 'Pipeline')).toBe('exclude');
  });
});
