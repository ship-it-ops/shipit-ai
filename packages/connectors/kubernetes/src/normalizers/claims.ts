import type { CanonicalEdge, CanonicalNode, PropertyClaim } from '@shipit-ai/shared';
import { deriveContentVersion } from '@shipit-ai/shared';
import type { NormalizerContext } from '../types.js';

export const KUBERNETES_CLAIM_CONFIDENCE = 0.85;
export const LOGICAL_SERVICE_CLAIM_CONFIDENCE = 0.7;

/** Drop `undefined` values so missing source data omits the property (never fabricated). */
export function compact<T extends Record<string, unknown>>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}

export function makeClaims(
  properties: Record<string, unknown>,
  sourceId: string,
  now: string,
  confidence = KUBERNETES_CLAIM_CONFIDENCE,
): PropertyClaim[] {
  return Object.entries(properties).map(([property_key, value]) => ({
    property_key,
    value,
    source: 'kubernetes',
    source_id: sourceId,
    ingested_at: now,
    confidence,
    evidence: null,
  }));
}

/** Node with kubernetes provenance; `properties` must already be compacted. */
export function makeNode(
  id: string,
  label: string,
  properties: Record<string, unknown>,
  sourceId: string,
  ctx: NormalizerContext,
  confidence = KUBERNETES_CLAIM_CONFIDENCE,
): CanonicalNode {
  return {
    id,
    label,
    properties,
    _claims: makeClaims(properties, sourceId, ctx.now, confidence),
    _source_system: 'kubernetes',
    _source_org: `kubernetes/${ctx.cluster}`,
    _source_id: sourceId,
    _last_synced: ctx.now,
    // Polling cannot deliver out of order; a content hash makes re-syncs of
    // unchanged content dedup and any change reach the writer (Cut B semantics).
    _event_version: deriveContentVersion(properties),
  };
}

export function makeEdge(
  type: string,
  from: string,
  to: string,
  confidence: number,
  now: string,
  properties?: Record<string, unknown>,
): CanonicalEdge {
  return {
    type,
    from,
    to,
    ...(properties ? { properties } : {}),
    _source: 'kubernetes',
    _confidence: confidence,
    _ingested_at: now,
  };
}
