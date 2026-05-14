'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Input } from '@ship-it-ui/ui';
import { IconGlyph } from '@ship-it-ui/icons';

const STORAGE_KEY = 'shipit:saved-queries';

export interface SavedQuery {
  id: string;
  name: string;
  cypher: string;
  createdAt: string;
}

const STARTER_QUERIES: ReadonlyArray<Omit<SavedQuery, 'id' | 'createdAt'>> = [
  {
    name: 'Node counts by label',
    cypher: `MATCH (n)
RETURN labels(n)[0] AS label, count(*) AS count
ORDER BY count DESC`,
  },
  {
    name: 'Tier-1 services',
    cypher: `MATCH (s:LogicalService)
WHERE s.tier_effective = 1 OR s.tier = 1
RETURN s.id AS id, s.name AS name, s.owner_effective AS owner
LIMIT 50`,
  },
  {
    name: 'Stale deployments',
    cypher: `MATCH (d:Deployment)
WHERE d._last_synced < datetime() - duration({hours: 24})
RETURN d.id AS id, d.name AS name, d._last_synced AS lastSync
ORDER BY d._last_synced ASC
LIMIT 50`,
  },
  {
    name: 'Services without an owning team',
    cypher: `MATCH (s:LogicalService)
WHERE NOT (s)<-[:OWNS]-(:Team)
RETURN s.id AS id, s.name AS name
LIMIT 50`,
  },
];

function load(): SavedQuery[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as SavedQuery[];
  } catch {
    // ignore corrupted storage
  }
  // First visit — seed with the starter library so users have something to run.
  return STARTER_QUERIES.map((q) => ({
    ...q,
    id: `starter:${q.name}`,
    createdAt: new Date().toISOString(),
  }));
}

function persist(queries: SavedQuery[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(queries));
  } catch {
    // localStorage can be disabled or quota-exceeded — drop silently.
  }
}

export interface SavedQueriesProps {
  currentCypher: string;
  onLoad: (cypher: string) => void;
}

export function SavedQueries({ currentCypher, onLoad }: SavedQueriesProps) {
  const [queries, setQueries] = useState<SavedQuery[]>([]);
  const [name, setName] = useState('');

  // Load once on mount — purely client-side state.
  useEffect(() => {
    setQueries(load());
  }, []);

  const save = useCallback(() => {
    const trimmed = name.trim();
    if (!trimmed || !currentCypher.trim()) return;
    const entry: SavedQuery = {
      id: `q-${Date.now()}`,
      name: trimmed,
      cypher: currentCypher,
      createdAt: new Date().toISOString(),
    };
    setQueries((prev) => {
      const next = [entry, ...prev];
      persist(next);
      return next;
    });
    setName('');
  }, [name, currentCypher]);

  const remove = useCallback((id: string) => {
    setQueries((prev) => {
      const next = prev.filter((q) => q.id !== id);
      persist(next);
      return next;
    });
  }, []);

  return (
    <Card title="Saved queries" className="flex h-full flex-col">
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name this query…"
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
            }}
            size="sm"
          />
          <Button size="sm" onClick={save} disabled={!name.trim() || !currentCypher.trim()}>
            Save
          </Button>
        </div>

        <ul className="flex max-h-[420px] flex-col gap-1 overflow-auto">
          {queries.length === 0 && (
            <li className="text-text-dim px-2 py-3 text-[12px]">
              No saved queries yet. Write a query and name it above.
            </li>
          )}
          {queries.map((q) => (
            <li
              key={q.id}
              className="border-border bg-panel hover:bg-panel-2 flex items-center gap-2 rounded-xs border px-2 py-1.5"
            >
              <button
                type="button"
                onClick={() => onLoad(q.cypher)}
                className="text-text hover:text-accent flex-1 text-left text-[12px]"
                title={q.cypher}
              >
                {q.name}
              </button>
              <button
                type="button"
                onClick={() => remove(q.id)}
                aria-label={`Delete ${q.name}`}
                className="text-text-dim hover:text-err"
              >
                <IconGlyph name="close" size={12} />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
