import { describe, it, expect } from 'vitest';
import type { Config } from '@shipit-ai/shared';
import {
  applyDerivedAuthConfig,
  assertAuthConfigBootable,
  AuthConfigError,
  evaluateAuthBootability,
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
