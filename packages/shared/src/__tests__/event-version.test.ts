import { describe, it, expect } from 'vitest';
import type { CanonicalNode } from '../index.js';
import {
  deriveTimeVersion,
  deriveContentVersion,
  deriveNodeContentHash,
  isContentVersion,
  CONTENT_VERSION_PREFIX,
} from '../utils/event-version.js';

describe('deriveTimeVersion', () => {
  it('parses an ISO-8601 string to epoch ms', () => {
    expect(deriveTimeVersion('2026-06-19T00:00:00.000Z')).toBe(
      Date.parse('2026-06-19T00:00:00.000Z'),
    );
  });

  it('passes through an epoch-ms number', () => {
    expect(deriveTimeVersion(1_718_000_000_000)).toBe(1_718_000_000_000);
  });

  it('returns the MAX over multiple inputs (pushed_at can win over updated_at)', () => {
    const updated = '2026-06-01T00:00:00.000Z';
    const pushed = '2026-06-19T00:00:00.000Z';
    expect(deriveTimeVersion(updated, pushed)).toBe(Date.parse(pushed));
  });

  it('ignores null/undefined/unparseable inputs', () => {
    const t = '2026-06-19T00:00:00.000Z';
    expect(deriveTimeVersion(undefined, null, 'not-a-date', t)).toBe(Date.parse(t));
  });

  it('returns null (NOT NaN/0/-Infinity) when nothing parses', () => {
    const r = deriveTimeVersion(undefined, null, 'garbage');
    expect(r).toBeNull();
    expect(Number.isNaN(r as unknown as number)).toBe(false);
  });

  it('returns null for no inputs at all', () => {
    expect(deriveTimeVersion()).toBeNull();
  });
});

describe('deriveContentVersion', () => {
  it('is deterministic for equal content', () => {
    const a = deriveContentVersion({ name: 'x', tier: 1 });
    const b = deriveContentVersion({ name: 'x', tier: 1 });
    expect(a).toBe(b);
  });

  it('is order-independent over object keys', () => {
    expect(deriveContentVersion({ a: 1, b: 2 })).toBe(deriveContentVersion({ b: 2, a: 1 }));
  });

  it('changes when content changes', () => {
    expect(deriveContentVersion({ name: 'x' })).not.toBe(deriveContentVersion({ name: 'y' }));
  });

  it('is sentinel-prefixed and colon-free (survives BullMQ key)', () => {
    const v = deriveContentVersion({ a: 1 });
    expect(v.startsWith(CONTENT_VERSION_PREFIX)).toBe(true);
    expect(v).not.toContain(':');
    expect(isContentVersion(v)).toBe(true);
  });
});

describe('isContentVersion', () => {
  it('distinguishes content hashes from numbers and ISO strings', () => {
    expect(isContentVersion(deriveContentVersion({ a: 1 }))).toBe(true);
    expect(isContentVersion(1)).toBe(false);
    expect(isContentVersion(1_718_000_000_000)).toBe(false);
    expect(isContentVersion('2026-06-19T00:00:00.000Z')).toBe(false);
    expect(isContentVersion(null)).toBe(false);
    expect(isContentVersion(undefined)).toBe(false);
  });
});

describe('deriveNodeContentHash (dedup key fingerprint)', () => {
  const base = (): CanonicalNode => ({
    id: 'shipit://Repository/default/acme/web',
    label: 'Repository',
    properties: { name: 'web', language: 'TypeScript' },
    _claims: [
      {
        property_key: 'language',
        value: 'TypeScript',
        source: 'github',
        source_id: 'github://acme/web',
        ingested_at: '2026-06-19T00:00:00.000Z',
        confidence: 0.9,
        evidence: null,
      },
    ],
    _source_system: 'github',
    _source_org: 'github/acme',
    _source_id: 'github://acme/web',
    _last_synced: '2026-06-19T00:00:00.000Z',
    _event_version: 1,
  });

  it('is stable across volatile-only changes (_last_synced, claim ingested_at, _event_version)', () => {
    const a = base();
    const b = base();
    b._last_synced = '2026-06-20T12:34:56.000Z';
    b._event_version = 1_718_999_999_999;
    b._claims[0].ingested_at = '2026-06-20T12:34:56.000Z';
    expect(deriveNodeContentHash(a)).toBe(deriveNodeContentHash(b));
  });

  it('changes when a property changes', () => {
    const a = base();
    const b = base();
    b.properties.language = 'Go';
    expect(deriveNodeContentHash(a)).not.toBe(deriveNodeContentHash(b));
  });

  it('changes when a claim value changes', () => {
    const a = base();
    const b = base();
    b._claims[0].value = 'Go';
    expect(deriveNodeContentHash(a)).not.toBe(deriveNodeContentHash(b));
  });

  it('is colon-free hex', () => {
    expect(deriveNodeContentHash(base())).toMatch(/^[0-9a-f]+$/);
  });
});
