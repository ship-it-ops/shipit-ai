import { describe, it, expect } from 'vitest';
import { assertNotProduction } from './seed-reset.js';

describe('assertNotProduction', () => {
  it('allows dev environment', () => {
    expect(() =>
      assertNotProduction({ nodeEnv: 'development', forceProduction: false }),
    ).not.toThrow();
  });

  it('allows missing NODE_ENV', () => {
    expect(() => assertNotProduction({ nodeEnv: undefined, forceProduction: false })).not.toThrow();
  });

  it('allows test environment', () => {
    expect(() => assertNotProduction({ nodeEnv: 'test', forceProduction: false })).not.toThrow();
  });

  it('refuses production without override', () => {
    expect(() => assertNotProduction({ nodeEnv: 'production', forceProduction: false })).toThrow(
      /NODE_ENV=production/,
    );
  });

  it('allows production with explicit --force-production override', () => {
    expect(() =>
      assertNotProduction({ nodeEnv: 'production', forceProduction: true }),
    ).not.toThrow();
  });
});
