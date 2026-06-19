import { createHash } from 'node:crypto';
import type { CanonicalNode } from '../types/canonical.js';

/**
 * Helpers for `_event_version` (the freshness/ordering token) and the
 * content-derived idempotency-dedup key.
 *
 * Cut B splits two concerns that used to share one field:
 *   - `_event_version` = ORDERING token. Comparable (epoch ms) for entities
 *     with a source timestamp; an opaque, sentinel-prefixed content hash for
 *     entities without one (those are unorderable → last-writer-wins).
 *   - the idempotency-dedup key = a CONTENT fingerprint of the node, so any
 *     genuine content change produces a new key (and is therefore NOT deduped
 *     away before the writer's freshness guard runs).
 *
 * Everything here is deterministic — NO `Date.now()` / volatile timestamps —
 * so unchanged content yields a stable value across sync runs.
 */

/** Sentinel prefix marking an opaque (non-orderable) content-hash version.
 *  Colon-free so it survives the BullMQ `:`→`~` job-id substitution. */
export const CONTENT_VERSION_PREFIX = 'ch_';

/** True when a version is an opaque content hash (not chronologically orderable). */
export function isContentVersion(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith(CONTENT_VERSION_PREFIX);
}

/**
 * Max epoch-ms over the parseable inputs (ISO-8601 strings or epoch numbers).
 * Returns `null` — NEVER `NaN`/`0`/`-Infinity` — when nothing parses, so callers
 * fall back to a content hash instead of persisting a poisoned numeric version
 * that would wedge the freshness guard. (`Date.parse(undefined) === NaN`.)
 */
export function deriveTimeVersion(
  ...inputs: Array<string | number | null | undefined>
): number | null {
  let max: number | null = null;
  for (const input of inputs) {
    if (input === null || input === undefined) continue;
    const ms = typeof input === 'number' ? input : Date.parse(input);
    if (Number.isFinite(ms)) max = max === null ? ms : Math.max(max, ms);
  }
  return max;
}

/** Recursively key-sorted JSON so structurally-equal values hash identically
 *  regardless of property insertion order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Stable, sentinel-prefixed sha256 of arbitrary content. Use as `_event_version`
 *  for entities that have no source timestamp (Team, Person). */
export function deriveContentVersion(content: unknown): string {
  const json = JSON.stringify(canonicalize(content));
  return CONTENT_VERSION_PREFIX + createHash('sha256').update(json).digest('hex');
}

/**
 * Content fingerprint of a node for the idempotency-DEDUP key (Option B).
 * Hashes the stable content surface — id, label, properties, source identity,
 * and each claim's `(property_key, value, source, confidence)` — while EXCLUDING
 * volatile fields (`_last_synced`, claim `ingested_at`) and the ordering token
 * (`_event_version`). Colon-free hex. Unchanged content → identical fingerprint
 * (dedups); any content change → new fingerprint (reaches the writer guard).
 */
export function deriveNodeContentHash(node: CanonicalNode): string {
  const stable = {
    id: node.id,
    label: node.label,
    properties: node.properties ?? {},
    source_system: node._source_system,
    source_org: node._source_org,
    source_id: node._source_id,
    claims: (node._claims ?? []).map((c) => ({
      property_key: c.property_key,
      value: c.value,
      source: c.source,
      confidence: c.confidence,
    })),
  };
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(stable)))
    .digest('hex')
    .slice(0, 32);
}
