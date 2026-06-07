import { describe, expect, it } from 'vitest';
import {
  buildCapabilitySet,
  hasCapability,
  SYSTEM_CONTEXT,
  type RequestContext,
} from '../auth/request-context.js';

function makeCtx(capabilities: string[]): RequestContext {
  return {
    user: {
      id: 'user-1',
      email: 'user@example.com',
      displayName: 'User One',
      provider: 'oidc',
      role: 'member',
      capabilities,
    },
    org: 'default',
    capabilities: buildCapabilitySet(capabilities),
    requestId: 'req-1',
  };
}

describe('hasCapability', () => {
  it('returns true for an explicitly granted capability', () => {
    const ctx = makeCtx(['graph:read', 'graph:write']);
    expect(hasCapability(ctx, 'graph:write')).toBe(true);
  });

  it('returns false for an ungranted capability', () => {
    const ctx = makeCtx(['graph:read']);
    expect(hasCapability(ctx, 'graph:write')).toBe(false);
  });

  it('treats * as a wildcard that grants every capability', () => {
    const ctx = makeCtx(['*']);
    expect(hasCapability(ctx, 'graph:write')).toBe(true);
    expect(hasCapability(ctx, 'connectors:manage')).toBe(true);
    expect(hasCapability(ctx, 'anything:at:all')).toBe(true);
  });
});

describe('SYSTEM_CONTEXT', () => {
  it('carries the wildcard capability so in-process callers always pass checks', () => {
    expect(hasCapability(SYSTEM_CONTEXT, 'graph:write')).toBe(true);
  });

  it('is org-scoped to default', () => {
    expect(SYSTEM_CONTEXT.org).toBe('default');
  });
});
