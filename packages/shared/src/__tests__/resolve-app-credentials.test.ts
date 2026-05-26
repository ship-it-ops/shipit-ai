import { describe, it, expect } from 'vitest';
import { resolveAppCredentials } from '../config/schema.js';

// The resolver is small but it's the single source of truth for the "shared
// App vs per-connector override" decision. Drift here would silently change
// which credentials a sync uses, so we lock the contract behavior down per
// override mode.
describe('resolveAppCredentials', () => {
  const global = { id: 'global-id', privateKeyPath: '/global/key.pem' };

  it('returns global App when connector has no override', () => {
    const r = resolveAppCredentials({}, global);
    expect(r.id).toBe('global-id');
    expect(r.privateKeyPath).toBe('/global/key.pem');
    expect(r.overridden).toBe(false);
  });

  it('returns global App when connector is undefined', () => {
    const r = resolveAppCredentials(undefined, global);
    expect(r.id).toBe('global-id');
    expect(r.privateKeyPath).toBe('/global/key.pem');
    expect(r.overridden).toBe(false);
  });

  it('returns per-connector override when both fields are present', () => {
    const r = resolveAppCredentials(
      { app: { id: 'org-app', privateKeyPath: '/org/key.pem' } },
      global,
    );
    expect(r.id).toBe('org-app');
    expect(r.privateKeyPath).toBe('/org/key.pem');
    expect(r.overridden).toBe(true);
  });

  it('mixes override id with global path when only id is overridden', () => {
    // Field-by-field fallback is intentional — lets admins swap the App
    // identity while keeping a shared key file, or vice versa.
    const r = resolveAppCredentials({ app: { id: 'org-app' } }, global);
    expect(r.id).toBe('org-app');
    expect(r.privateKeyPath).toBe('/global/key.pem');
    expect(r.overridden).toBe(true);
  });

  it('treats empty-string and whitespace fields as absent', () => {
    // Wizard tends to send empty strings rather than undefined when the
    // user clears a field; the resolver normalizes them to null so the
    // probe endpoint can report APP_NOT_CONFIGURED instead of authenticating
    // with garbage.
    const r = resolveAppCredentials(
      { app: { id: '   ', privateKeyPath: '' } },
      {
        id: '',
        privateKeyPath: '',
      },
    );
    expect(r.id).toBeNull();
    expect(r.privateKeyPath).toBeNull();
  });

  it('flags overridden=true even when only path is overridden', () => {
    const r = resolveAppCredentials({ app: { privateKeyPath: '/custom/key.pem' } }, global);
    expect(r.id).toBe('global-id');
    expect(r.privateKeyPath).toBe('/custom/key.pem');
    expect(r.overridden).toBe(true);
  });

  it('returns nulls when neither override nor global are configured', () => {
    const r = resolveAppCredentials({}, { id: '', privateKeyPath: '' });
    expect(r.id).toBeNull();
    expect(r.privateKeyPath).toBeNull();
    expect(r.overridden).toBe(false);
  });
});
