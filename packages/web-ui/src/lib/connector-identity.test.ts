import { describe, expect, it } from 'vitest';
import type { Connector } from '@/lib/api';
import { resolveConnectorIdentity } from './connector-identity';

// Minimal connector stub — resolveConnectorIdentity only reads `id` and `name`.
function connector(id: string, name: string): Connector {
  return { id, name } as Connector;
}

describe('resolveConnectorIdentity', () => {
  it('composes the type label once from a bare instance name', () => {
    const connectors = [connector('gh-ship-it-ops', 'ship-it-ops')];
    const identity = resolveConnectorIdentity('github', 'gh-ship-it-ops', connectors);
    expect(identity.displayName).toBe('GitHub · ship-it-ops');
    expect(identity.shortName).toBe('ship-it-ops');
    expect(identity.resolved).toBe(true);
  });

  it('does not double-prefix when the stored name already includes the type label', () => {
    // Legacy connectors created before the bare-name convention stored a
    // fully-composed `name` ("GitHub · ship-it-ops"). The helper must stay
    // idempotent so these render as "GitHub · ship-it-ops", not
    // "GitHub · GitHub · ship-it-ops".
    const connectors = [connector('gh-ship-it-ops', 'GitHub · ship-it-ops')];
    const identity = resolveConnectorIdentity('github', 'gh-ship-it-ops', connectors);
    expect(identity.displayName).toBe('GitHub · ship-it-ops');
    expect(identity.shortName).toBe('ship-it-ops');
  });

  it('falls back to the type label alone when no connector id is present', () => {
    const identity = resolveConnectorIdentity('github', null, []);
    expect(identity.displayName).toBe('GitHub');
    expect(identity.resolved).toBe(false);
  });

  it('surfaces the raw id when the connector instance cannot be matched', () => {
    const identity = resolveConnectorIdentity('github', 'gh-deleted', []);
    expect(identity.displayName).toBe('GitHub · gh-deleted');
    expect(identity.shortName).toBe('gh-deleted');
    expect(identity.resolved).toBe(false);
  });
});
