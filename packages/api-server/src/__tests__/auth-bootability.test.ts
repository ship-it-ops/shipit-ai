import { describe, it, expect } from 'vitest';
import type { Config } from '@shipit-ai/shared';
import {
  applyDerivedAuthConfig,
  assertAuthConfigBootable,
  AuthConfigError,
  evaluateAuthBootability,
  shouldEnterSetupMode,
  type SetupModeDecision,
} from '../auth-bootability.js';
import { makeTestConfig } from './test-config.js';

const SESSION_SECRET = 'a'.repeat(32);

// Auth-enabled config that passes every gate — tests below knock out one
// gate at a time.
function bootableAuthConfig(): Config {
  const config = makeTestConfig();
  config.accessControl.auth.enabled = true;
  config.accessControl.auth.providers.github.enabled = true;
  config.accessControl.auth.providers.github.clientId = 'Iv1.abc';
  config.accessControl.auth.admins = ['admin@example.com'];
  return config;
}

describe('evaluateAuthBootability', () => {
  it('is always bootable with auth disabled', () => {
    const result = evaluateAuthBootability(makeTestConfig(), {} as NodeJS.ProcessEnv);
    expect(result).toEqual({ bootable: true, missing: [], messages: [] });
  });

  it('passes a fully configured deployment', () => {
    const env = { SHIPIT_SESSION_SECRET: SESSION_SECRET } as NodeJS.ProcessEnv;
    const result = evaluateAuthBootability(bootableAuthConfig(), env);
    expect(result.bootable).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it('reports the provider gate', () => {
    const config = bootableAuthConfig();
    config.accessControl.auth.providers.github.enabled = false;
    const env = { SHIPIT_SESSION_SECRET: SESSION_SECRET } as NodeJS.ProcessEnv;
    const result = evaluateAuthBootability(config, env);
    expect(result.bootable).toBe(false);
    expect(result.missing).toEqual(['provider']);
    expect(result.messages[0]).toContain('no provider is enabled');
  });

  it('reports the admins gate', () => {
    const config = bootableAuthConfig();
    config.accessControl.auth.admins = [];
    const env = { SHIPIT_SESSION_SECRET: SESSION_SECRET } as NodeJS.ProcessEnv;
    const result = evaluateAuthBootability(config, env);
    expect(result.missing).toEqual(['admins']);
  });

  it('reports the allowedOrigins gate', () => {
    const config = bootableAuthConfig();
    config.accessControl.web.allowedOrigins = [];
    const env = { SHIPIT_SESSION_SECRET: SESSION_SECRET } as NodeJS.ProcessEnv;
    const result = evaluateAuthBootability(config, env);
    expect(result.missing).toEqual(['allowedOrigins']);
  });

  it('reports the sessionSecret gate for missing and too-short values', () => {
    const config = bootableAuthConfig();
    expect(evaluateAuthBootability(config, {} as NodeJS.ProcessEnv).missing).toEqual([
      'sessionSecret',
    ]);
    const short = { SHIPIT_SESSION_SECRET: 'short' } as NodeJS.ProcessEnv;
    expect(evaluateAuthBootability(config, short).missing).toEqual(['sessionSecret']);
  });

  it('collects every failing gate (the committed fresh-deploy state)', () => {
    const config = bootableAuthConfig();
    config.accessControl.auth.providers.github.enabled = false;
    config.accessControl.auth.admins = [];
    const result = evaluateAuthBootability(config, {} as NodeJS.ProcessEnv);
    expect(result.missing).toEqual(['provider', 'admins', 'sessionSecret']);
  });
});

describe('assertAuthConfigBootable', () => {
  it('throws AuthConfigError with the first failing message', () => {
    const config = bootableAuthConfig();
    config.accessControl.auth.providers.github.enabled = false;
    expect(() => assertAuthConfigBootable(config, {} as NodeJS.ProcessEnv)).toThrow(
      AuthConfigError,
    );
    expect(() => assertAuthConfigBootable(config, {} as NodeJS.ProcessEnv)).toThrow(
      /no provider is enabled/,
    );
  });

  it('does not throw for a bootable config', () => {
    const env = { SHIPIT_SESSION_SECRET: SESSION_SECRET } as NodeJS.ProcessEnv;
    expect(() => assertAuthConfigBootable(bootableAuthConfig(), env)).not.toThrow();
  });
});

describe('shouldEnterSetupMode', () => {
  // The genuinely-fresh GKE deploy: gsm store, nothing hydrated, the
  // committed config failing on the wizard-fixable gates.
  const FRESH: SetupModeDecision = {
    bootable: false,
    missing: ['provider', 'admins'],
    storeKind: 'gsm',
    hydratedCount: 0,
    setupCompleted: false,
    forced: false,
  };

  it('enters setup mode on a fresh gsm deployment', () => {
    expect(shouldEnterSetupMode(FRESH)).toBe(true);
  });

  it('never enters setup mode when the config is bootable', () => {
    expect(shouldEnterSetupMode({ ...FRESH, bootable: true, missing: [] })).toBe(false);
  });

  it('re-enters setup mode after a mid-wizard pod restart (partial secrets, latch unset)', () => {
    // e.g. admin email persisted before the crash; provider still missing.
    expect(shouldEnterSetupMode({ ...FRESH, missing: ['provider'], hydratedCount: 1 })).toBe(true);
  });

  it('REGRESSION (PR #59 SC2): a completed deployment that loses a secret fails loud, not setup', () => {
    // Previously-secured deployment whose OAuth client secret vanished
    // from GSM: the only failing gate is wizard-fixable, but the latch is
    // set — reopening the wizard here would hand admin to whoever reaches
    // the ingress first.
    expect(
      shouldEnterSetupMode({
        ...FRESH,
        missing: ['provider'],
        hydratedCount: 3,
        setupCompleted: true,
      }),
    ).toBe(false);
  });

  it('the latch also vetoes the zero-hydrated branch (catastrophic secret wipe)', () => {
    expect(shouldEnterSetupMode({ ...FRESH, setupCompleted: true })).toBe(false);
  });

  it('stays loud when any failing gate is operator-only', () => {
    expect(
      shouldEnterSetupMode({ ...FRESH, missing: ['provider', 'sessionSecret'], hydratedCount: 2 }),
    ).toBe(false);
  });

  it('never triggers for file-kind stores', () => {
    expect(shouldEnterSetupMode({ ...FRESH, storeKind: 'file' })).toBe(false);
  });

  it('the dev escape hatch forces setup mode regardless of store kind', () => {
    expect(shouldEnterSetupMode({ ...FRESH, storeKind: 'file', forced: true })).toBe(true);
  });
});

describe('applyDerivedAuthConfig', () => {
  it('flips github provider on when GSM hydrated the OAuth client', () => {
    const config = makeTestConfig();
    config.accessControl.auth.enabled = true;
    const env = {
      GITHUB_OAUTH_CLIENT_ID: 'Iv1.abc',
      GITHUB_OAUTH_CLIENT_SECRET: 'hush',
    } as NodeJS.ProcessEnv;
    const result = applyDerivedAuthConfig(config, env, 'gsm');
    expect(result.derivedGithubProvider).toBe(true);
    expect(config.accessControl.auth.providers.github.enabled).toBe(true);
    expect(config.accessControl.auth.providers.github.clientId).toBe('Iv1.abc');
  });

  it('does not derive the provider for file-kind stores', () => {
    const config = makeTestConfig();
    const env = {
      GITHUB_OAUTH_CLIENT_ID: 'Iv1.abc',
      GITHUB_OAUTH_CLIENT_SECRET: 'hush',
    } as NodeJS.ProcessEnv;
    const result = applyDerivedAuthConfig(config, env, 'file');
    expect(result.derivedGithubProvider).toBe(false);
    expect(config.accessControl.auth.providers.github.enabled).toBe(false);
  });

  it('requires BOTH the client id and secret to derive the provider', () => {
    const config = makeTestConfig();
    const env = { GITHUB_OAUTH_CLIENT_ID: 'Iv1.abc' } as NodeJS.ProcessEnv;
    expect(applyDerivedAuthConfig(config, env, 'gsm').derivedGithubProvider).toBe(false);
  });

  it('does not clobber an explicitly configured clientId', () => {
    const config = makeTestConfig();
    config.accessControl.auth.providers.github.clientId = 'Iv1.from-config';
    const env = {
      GITHUB_OAUTH_CLIENT_ID: 'Iv1.from-env',
      GITHUB_OAUTH_CLIENT_SECRET: 'hush',
    } as NodeJS.ProcessEnv;
    applyDerivedAuthConfig(config, env, 'gsm');
    expect(config.accessControl.auth.providers.github.clientId).toBe('Iv1.from-config');
  });

  it('fills empty admins[] from the SHIPIT_AUTH_ADMINS CSV (any store kind)', () => {
    const config = makeTestConfig();
    const env = { SHIPIT_AUTH_ADMINS: ' a@x.com , b@y.com ,' } as NodeJS.ProcessEnv;
    const result = applyDerivedAuthConfig(config, env, 'file');
    expect(result.derivedAdmins).toBe(true);
    expect(config.accessControl.auth.admins).toEqual(['a@x.com', 'b@y.com']);
  });

  it('never overrides a non-empty admins list', () => {
    const config = makeTestConfig();
    config.accessControl.auth.admins = ['configured@example.com'];
    const env = { SHIPIT_AUTH_ADMINS: 'derived@example.com' } as NodeJS.ProcessEnv;
    const result = applyDerivedAuthConfig(config, env, 'gsm');
    expect(result.derivedAdmins).toBe(false);
    expect(config.accessControl.auth.admins).toEqual(['configured@example.com']);
  });
});

// Mirrors the SHIPIT_AUTH_ADMINS derivation: the login allow-list lives in
// GSM (operator-managed via gcloud, no app writes) and hydrates to
// SHIPIT_AUTH_ALLOWLIST so the guardrail can change without a deploy.
describe('applyDerivedAuthConfig — allow-list derivation', () => {
  it('fills empty allowList from the SHIPIT_AUTH_ALLOWLIST CSV (any store kind)', () => {
    const config = makeTestConfig();
    const env = { SHIPIT_AUTH_ALLOWLIST: ' a@x.com , b@y.com ,' } as NodeJS.ProcessEnv;
    const result = applyDerivedAuthConfig(config, env, 'file');
    expect(result.derivedAllowList).toBe(true);
    expect(config.accessControl.auth.allowList).toEqual(['a@x.com', 'b@y.com']);
  });

  it('never overrides a non-empty configured allowList', () => {
    const config = makeTestConfig();
    config.accessControl.auth.allowList = ['configured@example.com'];
    const env = { SHIPIT_AUTH_ALLOWLIST: 'derived@example.com' } as NodeJS.ProcessEnv;
    const result = applyDerivedAuthConfig(config, env, 'gsm');
    expect(result.derivedAllowList).toBe(false);
    expect(config.accessControl.auth.allowList).toEqual(['configured@example.com']);
  });

  it('treats a whitespace-only env value as unset', () => {
    const config = makeTestConfig();
    const env = { SHIPIT_AUTH_ALLOWLIST: ' , ' } as NodeJS.ProcessEnv;
    const result = applyDerivedAuthConfig(config, env, 'file');
    expect(result.derivedAllowList).toBe(false);
    expect(config.accessControl.auth.allowList).toEqual([]);
  });
});
