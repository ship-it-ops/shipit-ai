// Single source of truth for per-source base trust, independence grouping, and
// resolution priority. Replaces the previously-scattered hardcoded confidences
// (connector normalizers stamped 0.9/0.95, login 0.85) and the two diverging
// priority lists (core-writer's SOURCE_PRIORITY vs api-server's
// DEFAULT_SOURCE_ORDER — see docs/agent/open-questions/manual-edit-write-path.md).
//
// `independence_group` is what makes corroboration meaningful: two sources in the
// SAME group (or one that `derivesFrom` the other) are NOT independent witnesses,
// so they must not stack a corroboration bonus. Example: Datadog/Backstage often
// re-import repo metadata from GitHub, so they share/derive the 'scm' lineage for
// those fields. v1 is source-level; per-property overrides are a v2 follow-up.

import type { PropertyClaim } from '../types/claims.js';

export interface SourceReliabilityEntry {
  /** Calibrated base trust for a fresh claim from this source, 0..1. */
  reliability: number;
  /** Independence cohort. Sources in the same group don't corroborate each other. */
  independence_group: string;
  /** Source names whose lineage this source re-derives (also not independent of). */
  derivesFrom: string[];
  /** Whether time-decay applies. Human attestations (manual/verified) do not decay. */
  decays: boolean;
}

export const SOURCE_RELIABILITY: Record<string, SourceReliabilityEntry> = {
  verified: { reliability: 0.99, independence_group: 'human', derivesFrom: [], decays: false },
  manual: { reliability: 0.95, independence_group: 'human', derivesFrom: [], decays: false },
  backstage: {
    reliability: 0.85,
    independence_group: 'catalog',
    derivesFrom: ['github'],
    decays: true,
  },
  github: { reliability: 0.9, independence_group: 'scm', derivesFrom: [], decays: true },
  // Authenticated-login self-claims arrive via GitHub OAuth, so they share SCM lineage.
  login: { reliability: 0.85, independence_group: 'scm', derivesFrom: ['github'], decays: true },
  kubernetes: { reliability: 0.85, independence_group: 'runtime', derivesFrom: [], decays: true },
  datadog: { reliability: 0.85, independence_group: 'apm', derivesFrom: [], decays: true },
  jira: { reliability: 0.8, independence_group: 'tracker', derivesFrom: [], decays: true },
  identity: { reliability: 0.85, independence_group: 'idp', derivesFrom: [], decays: true },
};

const DEFAULT_ENTRY: SourceReliabilityEntry = {
  reliability: 0.7,
  independence_group: 'unknown',
  derivesFrom: [],
  decays: true,
};

/**
 * Single ordered priority list consumed by BOTH the writer (AUTHORITATIVE_ORDER /
 * verified-and-manual-first) and the api-server read path, so they never disagree.
 * Earlier = higher priority.
 */
export const SOURCE_PRIORITY_ORDER: string[] = [
  'verified',
  'manual',
  'backstage',
  'github',
  'login',
  'kubernetes',
  'datadog',
  'jira',
  'identity',
];

/**
 * Normalize a claim `source` to its registry key. Sources may be namespaced
 * (`manual:alice@x`, `verified:bob@x`); the bare prefix is the registry key.
 */
export function sourceKey(source: string): string {
  const colon = source.indexOf(':');
  return colon === -1 ? source : source.slice(0, colon);
}

export function getSourceReliability(source: string): SourceReliabilityEntry {
  return SOURCE_RELIABILITY[sourceKey(source)] ?? DEFAULT_ENTRY;
}

export function independenceGroup(source: string): string {
  return getSourceReliability(source).independence_group;
}

/** Priority rank for a (possibly namespaced) source; unknown sources sort last. */
export function sourceRank(source: string): number {
  const idx = SOURCE_PRIORITY_ORDER.indexOf(sourceKey(source));
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

/**
 * True when `candidate` is not an independent witness relative to `winner`:
 * same independence group, or its lineage derives from the winner's source.
 */
export function isDerivedFrom(candidate: string, winner: string): boolean {
  const winnerKey = sourceKey(winner);
  const entry = getSourceReliability(candidate);
  if (entry.derivesFrom.includes(winnerKey)) return true;
  return independenceGroup(candidate) === independenceGroup(winner);
}

/**
 * Pick the winning human-attestation claim for the MANUAL_OVERRIDE_FIRST
 * strategy, DETERMINISTICALLY. `verified:<user>` outranks `manual:<user>`
 * (both are namespaced; we match the registry key, not array order).
 *
 * Why this lives in shared: BOTH core-writer's `resolveManualOverrideFirst`
 * and api-server's read-path `pickByStrategy` resolve this strategy, and they
 * MUST agree on the same winner. The previous `claims.find(...)` in each picked
 * by array order, which is non-deterministic across connector re-syncs (claim
 * order in `_claims` is not stable) — two equally-ranked `manual:<actor>`
 * claims could resolve to different effective values on different reads. The
 * tie-break below makes the winner a pure function of claim content:
 *   1. lowest sourceRank wins (verified before manual);
 *   2. then most-recent `ingested_at` (the freshest human edit);
 *   3. then `source` lexicographically as a final stable key.
 *
 * Returns null when no `verified:`/`manual:` claim is present (caller falls
 * back to its confidence-based strategy).
 */
export function pickManualOverride(claims: PropertyClaim[]): PropertyClaim | null {
  let best: PropertyClaim | null = null;
  for (const c of claims) {
    const key = sourceKey(c.source);
    if (key !== 'verified' && key !== 'manual') continue;
    if (best === null || compareOverride(c, best) < 0) best = c;
  }
  return best;
}

/** Ordering for human-attestation claims: lower sorts first (i.e. wins). */
function compareOverride(a: PropertyClaim, b: PropertyClaim): number {
  const ra = sourceRank(a.source);
  const rb = sourceRank(b.source);
  if (ra !== rb) return ra - rb;
  // Same rank (e.g. two manual claims): freshest ingested_at wins.
  if (a.ingested_at !== b.ingested_at) return a.ingested_at < b.ingested_at ? 1 : -1;
  // Final stable key so the result never depends on input order.
  return a.source < b.source ? -1 : a.source > b.source ? 1 : 0;
}
