'use client';

import {
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Input, Spinner } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';
import { getEntityTypeMeta } from '@ship-it-ui/shipit';
import { useSearch } from '@/lib/hooks/use-search';
import type { SearchResult } from '@/lib/api';

export interface EntitySearchBoxProps {
  /** Fires when the user picks a result. The input is cleared by default. */
  onSelect: (result: SearchResult) => void;
  /** Override the input placeholder. */
  placeholder?: string;
  size?: 'sm' | 'md' | 'lg';
  /** When provided, results matching this Cypher label are surfaced first. */
  preferLabel?: string;
  /** Keep the typed text after selection (defaults to clearing). */
  retainQueryOnSelect?: boolean;
  /** Initial focus. */
  autoFocus?: boolean;
  /** Optional className for the wrapping div. */
  className?: string;
  /** Extra slot rendered inside the listbox above results (e.g., a tip line). */
  beforeResults?: ReactNode;
}

const MIN_QUERY = 2;

export function EntitySearchBox({
  onSelect,
  placeholder = 'Search entities by name…',
  size = 'md',
  preferLabel,
  retainQueryOnSelect = false,
  autoFocus,
  className,
  beforeResults,
}: EntitySearchBoxProps) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const { data, isLoading, isFetching } = useSearch(query);

  // Results: filter empty + sort preferred label first. The backend already
  // does a CONTAINS match; we keep the original relevance order for the rest.
  const results = useMemo<SearchResult[]>(() => {
    if (!data) return [];
    if (!preferLabel) return data;
    return [...data].sort((a, b) => {
      const aHit = a.label === preferLabel;
      const bHit = b.label === preferLabel;
      if (aHit === bHit) return 0;
      return aHit ? -1 : 1;
    });
  }, [data, preferLabel]);

  // Reset the highlighted row whenever the result set changes so ↓/↑ start
  // from the top instead of pointing past the end of a shorter list.
  useEffect(() => {
    setCursor(0);
  }, [results.length]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const commit = useCallback(
    (result: SearchResult) => {
      onSelect(result);
      if (!retainQueryOnSelect) setQuery('');
      setOpen(false);
    },
    [onSelect, retainQueryOnSelect],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        setOpen(true);
        return;
      }
      if (e.key === 'Escape') {
        setOpen(false);
        return;
      }
      if (results.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setCursor((c) => (c + 1) % results.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => (c - 1 + results.length) % results.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const choice = results[cursor];
        if (choice) commit(choice);
      }
    },
    [open, results, cursor, commit],
  );

  const showLoadingHint = query.length >= MIN_QUERY && isLoading;
  const showEmptyHint =
    query.length >= MIN_QUERY && !isLoading && !isFetching && results.length === 0;
  const showTooShortHint = query.length > 0 && query.length < MIN_QUERY;

  return (
    <div ref={containerRef} className={`relative ${className ?? ''}`}>
      <Input
        ref={inputRef}
        size={size}
        icon={<IconGlyph name="search" size={size === 'lg' ? 16 : 12} />}
        placeholder={placeholder}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        autoFocus={autoFocus}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={
          open && results[cursor] ? `${listId}-${results[cursor].id}` : undefined
        }
      />

      {open && query.length > 0 && (
        <div
          id={listId}
          role="listbox"
          className="border-border bg-panel rounded-base absolute top-full right-0 left-0 z-30 mt-1 max-h-[360px] overflow-y-auto border shadow-lg"
        >
          {beforeResults}
          {showTooShortHint && (
            <div className="text-text-dim px-3 py-2 text-[12px]">
              Type at least {MIN_QUERY} characters to search.
            </div>
          )}
          {showLoadingHint && (
            <div className="text-text-dim flex items-center gap-2 px-3 py-2 text-[12px]">
              <Spinner size="sm" />
              Searching…
            </div>
          )}
          {showEmptyHint && (
            <div className="text-text-dim px-3 py-2 text-[12px]">
              No entities match &ldquo;{query}&rdquo;.
            </div>
          )}
          {results.map((r, i) => {
            const meta = getEntityTypeMeta(r.label);
            const isActive = i === cursor;
            return (
              <button
                key={r.id}
                type="button"
                id={`${listId}-${r.id}`}
                role="option"
                aria-selected={isActive}
                onClick={() => commit(r)}
                onMouseEnter={() => setCursor(i)}
                className={
                  'flex w-full items-center gap-3 px-3 py-2 text-left transition-colors ' +
                  (isActive ? 'bg-panel-2' : 'hover:bg-panel-2/60')
                }
              >
                <span className={`text-[16px] leading-none ${meta.toneClass}`} aria-hidden>
                  {meta.glyph}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="text-text truncate text-[13px] font-medium">{r.name}</span>
                  <span className="text-text-dim truncate font-mono text-[10px]">
                    {r.canonicalId}
                  </span>
                </span>
                <span className="text-text-muted shrink-0 text-[11px]">{meta.label}</span>
                {r.owner && <span className="text-text-dim shrink-0 text-[11px]">{r.owner}</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
