'use client';

import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'shipit:incident-recently-viewed';
const MAX_ENTRIES = 8;

export interface RecentEntry {
  id: string;
  name: string;
  type: string;
  visitedAt: string;
}

function readStorage(): RecentEntry[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is RecentEntry =>
        typeof e === 'object' &&
        e !== null &&
        typeof (e as RecentEntry).id === 'string' &&
        typeof (e as RecentEntry).name === 'string',
    );
  } catch {
    return [];
  }
}

function writeStorage(entries: RecentEntry[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // localStorage can throw under quota / private mode — silently no-op.
  }
}

/**
 * Tracks the services a user has opened in Incident Mode. Used by the
 * landing page to suggest "recently viewed" services so the IC isn't typing
 * the same service name repeatedly during a multi-page incident.
 */
export function useRecentlyViewed() {
  const [entries, setEntries] = useState<RecentEntry[]>([]);

  // Hydrate after mount — Next.js SSR doesn't have localStorage.
  useEffect(() => {
    setEntries(readStorage());
  }, []);

  const add = useCallback((entry: Omit<RecentEntry, 'visitedAt'>) => {
    setEntries((prev) => {
      const next: RecentEntry[] = [
        { ...entry, visitedAt: new Date().toISOString() },
        ...prev.filter((e) => e.id !== entry.id),
      ].slice(0, MAX_ENTRIES);
      writeStorage(next);
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setEntries([]);
    writeStorage([]);
  }, []);

  return { entries, add, clear };
}
