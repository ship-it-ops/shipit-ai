'use client';

import type { FilterPanelValue } from '@ship-it-ui/ui';
import { getTypeState, type TypeState } from './catalog-filter';

interface TypeOption {
  value: string;
  label: string;
}

interface TypeFilterProps {
  options: ReadonlyArray<TypeOption>;
  counts?: Record<string, number>;
  filter: FilterPanelValue;
  onCycle: (type: string) => void;
}

const STATE_HINT: Record<TypeState, string> = {
  neutral: 'Click to show only this type',
  include: 'Showing only this type · click to hide',
  exclude: 'Hidden · click to clear',
};

/**
 * Tri-state Type facet. Unlike the include-only DS FilterPanel facets, each
 * type cycles neutral → include → exclude → neutral on click. The exclude
 * state renders a negate (minus) indicator + struck-through label so it never
 * reads as a checkmark/include. Pipeline starts excluded (see makeDefaultFilter).
 */
export function TypeFilter({ options, counts, filter, onCycle }: TypeFilterProps) {
  if (options.length === 0) return null;
  return (
    <div className="mb-5">
      <div className="text-text-dim mb-2 font-mono text-[10px] font-medium tracking-[1.4px] uppercase">
        Type
      </div>
      <ul className="flex flex-col gap-px">
        {options.map((opt) => {
          const state = getTypeState(filter, opt.value);
          const count = counts?.[opt.value];
          const excluded = state === 'exclude';
          return (
            <li key={opt.value}>
              <button
                type="button"
                onClick={() => onCycle(opt.value)}
                // Tri-state can't be conveyed by binary aria-pressed (include
                // and exclude would both read as "pressed"), and the ✓/− glyph
                // is aria-hidden — so put the state in the accessible name.
                aria-label={`${opt.label} — ${STATE_HINT[state]}`}
                title={STATE_HINT[state]}
                className="hover:bg-panel-2 focus-visible:ring-accent-dim flex w-full items-center gap-2 rounded-sm px-1.5 py-1 text-left outline-none focus-visible:ring-[3px]"
              >
                <StateIndicator state={state} />
                <span
                  className={
                    'flex-1 text-[13px] ' + (excluded ? 'text-text-dim line-through' : 'text-text')
                  }
                >
                  {opt.label}
                </span>
                {typeof count === 'number' && (
                  <span className="text-text-dim font-mono text-[11px]">{count}</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function StateIndicator({ state }: { state: TypeState }) {
  const base =
    'flex h-4 w-4 shrink-0 items-center justify-center rounded-[3px] border text-[10px] leading-none';
  if (state === 'include') {
    return (
      <span className={base + ' border-accent bg-accent text-on-accent'} aria-hidden>
        ✓
      </span>
    );
  }
  if (state === 'exclude') {
    // Negate (minus) on an err-tinted chip — deliberately NOT a checkmark, so
    // an excluded type never reads as "included".
    return (
      <span className={base + ' border-err bg-err text-err-fg'} aria-hidden>
        −
      </span>
    );
  }
  return <span className={base + ' border-border-strong'} aria-hidden />;
}
