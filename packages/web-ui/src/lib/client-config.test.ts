import { describe, it, expect } from 'vitest';
import { normalizeApiBaseUrl } from './client-config';

// The production image is built with SHIPIT_API_URL=/api (single-origin
// Ingress); call sites append `/api/...`, so the prefix form must collapse
// to '' or every request becomes a double-prefixed `/api/api/...` that the
// api-server 404/401s (2026-06-11 first prod page-load incident).
describe('normalizeApiBaseUrl', () => {
  it("collapses the bare route prefix '/api' to same-origin ''", () => {
    expect(normalizeApiBaseUrl('/api')).toBe('');
  });

  it('tolerates trailing slashes on the prefix form', () => {
    expect(normalizeApiBaseUrl('/api/')).toBe('');
  });

  it('leaves a plain origin unchanged (local dev default)', () => {
    expect(normalizeApiBaseUrl('http://localhost:3001')).toBe('http://localhost:3001');
  });

  it('strips the route prefix from an origin+prefix value', () => {
    expect(normalizeApiBaseUrl('https://x.com/api')).toBe('https://x.com');
  });

  it('strips trailing slashes from an origin', () => {
    expect(normalizeApiBaseUrl('https://x.com/')).toBe('https://x.com');
  });
});
